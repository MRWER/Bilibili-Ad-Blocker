// content.js – 空间二次验证完整版（修正 WBI + 修复回退逻辑）
(function () {
  'use strict';
  console.log('[清剿] content.js 已注入 (空间验证修正版)');

  const COMMENT_SHADOW_HOST_SELECTOR = [
    'bili-comment-thread-renderer',
    'bili-comment-renderer',
    'bili-comment-replies-renderer',
    'bili-comment-reply-renderer',
    'bili-comment-user-info',
    'bili-rich-text',
    'bili-comment-action-buttons-renderer'
  ].join(', ');

  const observedShadowRoots = new WeakSet();
  let scanTimer = null;

  let autoCleanActive = false;
  let autoCleanQueue = [];
  let autoCleanTimer = null;
  let autoCleanPanel = null;
  let autoCleanListEl = null;
  let autoCleanCurrentEl = null;

  const profileCache = new Map();
  const CACHE_DURATION = 5 * 60 * 1000; // 5分钟
  const pendingProfileChecks = new Map();  // uid -> Promise

  // ========== 工具函数 ==========
  // 安全获取元素的开放式 Shadow Root，避免访问异常打断流程。
  function getOpenShadow(el) {
    try { return el && el.shadowRoot ? el.shadowRoot : null; } catch { return null; }
  }
  // 在指定根节点下查询单个元素。
  function q(root, sel) { return root && root.querySelector ? root.querySelector(sel) : null; }
  // 在指定根节点下查询多个元素并转为数组。
  function qa(root, sel) { return root && root.querySelectorAll ? [...root.querySelectorAll(sel)] : []; }
  // 统一清洗文本中的空白字符，便于后续匹配和比较。
  function normalizeText(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  // 获取元素标签名，并统一转换为大写格式。
  function getTagName(el) { return el?.tagName ? String(el.tagName).toUpperCase() : ''; }

  // 尝试从评论组件实例或挂载数据中提取原始评论数据。
  function getCommentData(el) {
    if (!el) return null;
    const vueInstance = el.__vue__ || el._vue__ || el.__vue_app__ || el._data || null;
    if (vueInstance) return vueInstance.data || vueInstance._data || vueInstance;
    if (el.__data) return el.__data;
    return null;
  }

  // 从文本中拆解可学习的中文词、英文词和链接片段关键词。
  function extractKeywords(text) {
    if (!text) return [];
    const normalized = normalizeText(text);
    const cleanedChinese = normalized.replace(/[^\u4e00-\u9fa5]/g, '');
    const chineseWords = new Set();
    for (let len = 4; len >= 2; len--) {
      for (let i = 0; i <= cleanedChinese.length - len; i++) {
        chineseWords.add(cleanedChinese.substring(i, i + len));
      }
    }
    const cnStopwords = new Set(['可以','什么','怎么','为什么','觉得','还是','但是','因为','所以','如果','不过','只是','然后','已经','比较','非常','真的','这个','那个','一些','一个','自己','他们','我们','你们','没有','知道','出来','起来','过来','进去','就是','也是','不是','还有','的话','而已','而且','并且']);
    const cnResult = [...chineseWords].filter(w => w.length >= 2 && !cnStopwords.has(w));
    const englishWords = normalized.match(/[a-zA-Z]{2,}/g) || [];
    const enStopwords = new Set(['a','an','the','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','need','dare','ought','used','to','of','in','for','on','with','at','by','from','as','into','through','during','before','after','above','below','between','under','again','further','then','once','here','there','when','where','why','how','all','both','each','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','and','but','or','if','because','as','until','while','this','that','these','those','am','it','its','he','she','they','we','you','i','me','my','your','his','her','our','their','mine','yours','hers']);
    const enResult = [...new Set(englishWords)].map(w => w.toLowerCase()).filter(w => !enStopwords.has(w) && w.length >= 2);
    const urls = normalized.match(/https?:\/\/[^\s]+/g) || [];
    const urlKeywords = [];
    for (const url of urls) {
      try {
        const u = new URL(url);
        const hostParts = u.hostname.split('.');
        if (hostParts.length >= 2) urlKeywords.push(hostParts[hostParts.length - 2]);
        const pathParts = u.pathname.split('/').filter(p => p.length > 0);
        for (const part of pathParts) {
          if (/^[a-zA-Z0-9_-]+$/.test(part)) urlKeywords.push(part);
        }
      } catch (e) {}
    }
    const allWords = [...new Set([...cnResult, ...enResult, ...urlKeywords])];
    if (allWords.length === 0 && normalized.length < 20) return [normalized];
    return allWords;
  }

  // 评论区宿主
  function getCommentsHost() {
    const direct = document.querySelector('bili-comments');
    if (direct) return direct;
    const commentApp = document.querySelector('#commentapp');
    if (commentApp) {
      const nested = commentApp.querySelector('bili-comments');
      if (nested) return nested;
    }
    return null;
  }

  // 从评论数据对象中提取用户等级，兼容多种字段结构。
  function extractLevelFromData(commentData) {
    if (!commentData) return null;
    const candidates = [commentData?.member?.level_info?.current_level, commentData?.member?.level_info?.currentLevel, commentData?.reply_control?.user_level, commentData?.member?.level, commentData?.user_level, commentData?.level, commentData?.info?.level, commentData?.info?.level_info?.current_level, commentData?.content?.member?.level_info?.current_level];
    for (const candidate of candidates) {
      const level = Number(candidate);
      if (Number.isFinite(level) && level > 0 && level <= 6) return level;
    }
    if (commentData?.member?.is_hardcore_vip === true || commentData?.member?.is_hardcore_vip === 1) return 6;
    return null;
  }

  // 优先从渲染节点和等级图标中推断评论用户等级。
  function extractLevelFromRenderer(commentRenderer) {
    const dataLevel = extractLevelFromData(getCommentData(commentRenderer));
    if (dataLevel != null) return dataLevel;
    const sr = getOpenShadow(commentRenderer);
    if (!sr) return null;
    const infoHost = q(sr, 'bili-comment-user-info');
    if (infoHost) {
      const infoSr = getOpenShadow(infoHost);
      if (infoSr) {
        const levelImg = q(infoSr, '#user-level img') || q(infoSr, '.level-icon') || q(infoSr, '[class*="level"] img');
        if (levelImg) {
          const imgSrc = levelImg.getAttribute('src') || '';
          let match = imgSrc.match(/level_(\d+)\.(?:svg|png)/i) || imgSrc.match(/lv(\d+)\.(?:svg|png)/i);
          if (match) return Number(match[1]);
        }
        const levelEl = q(infoSr, '#user-level') || q(infoSr, '[class*="level"]');
        if (levelEl) {
          const levelText = levelEl.getAttribute('alt') || levelEl.getAttribute('title') || levelEl.textContent;
          if (levelText) {
            const textMatch = levelText.match(/lv(\d+)/i) || levelText.match(/level\s*(\d+)/i);
            if (textMatch) return Number(textMatch[1]);
          }
        }
      }
    }
    const allImgs = qa(sr, 'img[src*="level"], img[class*="level"]');
    for (const img of allImgs) {
      const imgSrc = img.getAttribute('src') || '';
      const match = imgSrc.match(/level_(\d+)\.(?:svg|png)/i) || imgSrc.match(/lv(\d+)\.(?:svg|png)/i);
      if (match) return Number(match[1]);
    }
    return null;
  }

  // 从富文本评论宿主中提取最终显示给用户的评论文本。
  function extractTextFromRichTextHost(richHost) {
    if (!richHost) return '';
    const sr = getOpenShadow(richHost);
    const el = q(sr, '#contents') || q(sr, 'p#contents') || richHost;
    return normalizeText(el?.innerText || el?.textContent || '');
  }

  // 统一把不同类型的评论节点解析为实际评论渲染节点。
  function resolveCommentRenderer(target) {
    if (!target) return null;
    const tag = getTagName(target);
    if (tag === 'BILI-COMMENT-THREAD-RENDERER') {
      const sr = getOpenShadow(target);
      return q(sr, '#comment') || q(sr, 'bili-comment-renderer');
    }
    if (tag === 'BILI-COMMENT-REPLY-RENDERER' || tag === 'BILI-COMMENT-RENDERER') return target;
    return null;
  }

  // 从评论节点中组装后续识别与操作所需的完整评论信息。
  function extractCommentDataFromTarget(target) {
    const renderer = resolveCommentRenderer(target);
    if (!renderer) return null;
    const sr = getOpenShadow(renderer);
    if (!sr) return null;
    const dataSource = getCommentData(target) || getCommentData(renderer);
    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const nameLink = q(infoSr, '#user-name a') || q(infoSr, '#user-name') || q(sr, '#header a[href*="space.bilibili.com/"]');
    const avatarLink = q(sr, '#user-avatar[href*="space.bilibili.com/"]') || q(sr, 'a[href*="space.bilibili.com/"]');
    const uidFromData = dataSource?.mid || dataSource?.member?.mid || null;
    const uidFromLinkMatch = (nameLink?.href || avatarLink?.href || '').match(/space\.bilibili\.com\/(\d+)/);
    const uid = uidFromData ? String(uidFromData) : (uidFromLinkMatch ? uidFromLinkMatch[1] : null);
    if (!uid) return null;
    const richHost = q(sr, '#content bili-rich-text') || q(sr, '#reply-content bili-rich-text') || q(sr, '#body bili-rich-text') || q(sr, 'bili-rich-text');
    const textFromData = normalizeText(dataSource?.content?.message || dataSource?.content?.text || '');
    const text = textFromData || extractTextFromRichTextHost(richHost);
    if (!text) return null;
    const name = normalizeText(dataSource?.member?.uname || nameLink?.innerText || nameLink?.textContent || '未命名');
    const level = extractLevelFromData(dataSource) ?? extractLevelFromRenderer(renderer);
    let linkText = '';
    try {
      const linkRenderer = resolveCommentRenderer(target);
      if (linkRenderer) {
        const linkSr = getOpenShadow(linkRenderer);
        if (linkSr) {
          const allLinks = qa(linkSr, '#contents a, #reply-content a, bili-rich-text a');
          if (allLinks.length > 0) linkText = allLinks.map(a => normalizeText(a.innerText || a.textContent || '')).filter(Boolean).join(' ');
        }
      }
    } catch (e) {}
    return { uid, name, text, level, linkText, element: target, actionHost: renderer };
  }

  // ========== WBI 签名相关 ==========
  let wbiKeys = { img_key: '', sub_key: '' };
  // 获取 B 站接口调用需要的 WBI 签名密钥。
  async function fetchWbiKeys() {
    if (wbiKeys.img_key && wbiKeys.sub_key) return wbiKeys;
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
        headers: { 'User-Agent': navigator.userAgent, 'Referer': 'https://www.bilibili.com/' }
      });
      const json = await res.json();
      const imgUrl = json?.data?.wbi_img?.img_url || '';
      const subUrl = json?.data?.wbi_img?.sub_url || '';
      wbiKeys.img_key = imgUrl.split('/').pop().split('.')[0];
      wbiKeys.sub_key = subUrl.split('/').pop().split('.')[0];
    } catch (e) {
      console.warn('[清剿] WBI 密钥获取失败', e);
    }
    return wbiKeys;
  }

  // 计算请求签名使用的 MD5 值，内部包含所需的位运算辅助函数。
  function md5(string) {
    function rotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
    function addUnsigned(lX, lY) {
      let lX4, lY4, lX8, lY8, lResult;
      lX8 = (lX & 0x80000000); lY8 = (lY & 0x80000000);
      lX4 = (lX & 0x40000000); lY4 = (lY & 0x40000000);
      lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
      if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
      if (lX4 | lY4) { if (lResult & 0x40000000) return (lResult ^ 0xC0000000 ^ lX8 ^ lY8); else return (lResult ^ 0x40000000 ^ lX8 ^ lY8); }
      else return (lResult ^ lX8 ^ lY8);
    }
    function F(x,y,z) { return (x & y) | ((~x) & z); }
    function G(x,y,z) { return (x & z) | (y & (~z)); }
    function H(x,y,z) { return (x ^ y ^ z); }
    function I(x,y,z) { return (y ^ (x | (~z))); }
    function FF(a,b,c,d,x,s,ac) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b,c,d),x),ac)); return addUnsigned(rotateLeft(a,s),b); }
    function GG(a,b,c,d,x,s,ac) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b,c,d),x),ac)); return addUnsigned(rotateLeft(a,s),b); }
    function HH(a,b,c,d,x,s,ac) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b,c,d),x),ac)); return addUnsigned(rotateLeft(a,s),b); }
    function II(a,b,c,d,x,s,ac) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b,c,d),x),ac)); return addUnsigned(rotateLeft(a,s),b); }
    function convertToWordArray(string) {
      let lMessageLength = string.length;
      let lNumberOfWords_temp1 = lMessageLength + 8;
      let lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
      let lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
      let lWordArray = Array(lNumberOfWords - 1);
      let lBytePosition = 0, lByteCount = 0;
      let lWordCount = 0;  // 声明提到 while 外部，保证后面可访问
      while (lByteCount < lMessageLength) {
        lWordCount = (lByteCount - (lByteCount % 4)) / 4;   // 修正点：声明变量并正确拼写为 lWordCount
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition));
        lByteCount++;
      }
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;        // 此处 lWordCount 已在上一行声明，可复用
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
      lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
      lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
      return lWordArray;
    }
    function wordToHex(lValue) {
      let wordToHexValue = "", wordToHexValue_temp = "", lByte, lCount;
      for (lCount = 0; lCount <= 3; lCount++) {
        lByte = (lValue >>> (lCount * 8)) & 255;
        wordToHexValue_temp = "0" + lByte.toString(16);
        wordToHexValue = wordToHexValue + wordToHexValue_temp.substr(wordToHexValue_temp.length - 2, 2);
      }
      return wordToHexValue;
    }
    function utf8_encode(string) {
      string = string.replace(/\r\n/g, "\n");
      let utftext = "";
      for (let n = 0; n < string.length; n++) {
        let c = string.charCodeAt(n);
        if (c < 128) utftext += String.fromCharCode(c);
        else if ((c > 127) && (c < 2048)) {
          utftext += String.fromCharCode((c >> 6) | 192);
          utftext += String.fromCharCode((c & 63) | 128);
        } else {
          utftext += String.fromCharCode((c >> 12) | 224);
          utftext += String.fromCharCode(((c >> 6) & 63) | 128);
          utftext += String.fromCharCode((c & 63) | 128);
        }
      }
      return utftext;
    }
    let x = Array();
    let k, AA, BB, CC, DD, a, b, c, d;
    let S11 = 7, S12 = 12, S13 = 17, S14 = 22;
    let S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    let S31 = 4, S32 = 11, S33 = 16, S34 = 23;
    let S41 = 6, S42 = 10, S43 = 15, S44 = 21;
    string = utf8_encode(string);
    x = convertToWordArray(string);
    a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;
    for (k = 0; k < x.length; k += 16) {
      AA = a; BB = b; CC = c; DD = d;
      a = FF(a,b,c,d,x[k],S11,0xD76AA478); d = FF(d,a,b,c,x[k+1],S12,0xE8C7B756); c = FF(c,d,a,b,x[k+2],S13,0x242070DB); b = FF(b,c,d,a,x[k+3],S14,0xC1BDCEEE);
      a = FF(a,b,c,d,x[k+4],S11,0xF57C0FAF); d = FF(d,a,b,c,x[k+5],S12,0x4787C62A); c = FF(c,d,a,b,x[k+6],S13,0xA8304613); b = FF(b,c,d,a,x[k+7],S14,0xFD469501);
      a = FF(a,b,c,d,x[k+8],S11,0x698098D8); d = FF(d,a,b,c,x[k+9],S12,0x8B44F7AF); c = FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1); b = FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
      a = FF(a,b,c,d,x[k+12],S11,0x6B901122); d = FF(d,a,b,c,x[k+13],S12,0xFD987193); c = FF(c,d,a,b,x[k+14],S13,0xA679438E); b = FF(b,c,d,a,x[k+15],S14,0x49B40821);
      a = GG(a,b,c,d,x[k+1],S21,0xF61E2562); d = GG(d,a,b,c,x[k+6],S22,0xC040B340); c = GG(c,d,a,b,x[k+11],S23,0x265E5A51); b = GG(b,c,d,a,x[k],S24,0xE9B6C7AA);
      a = GG(a,b,c,d,x[k+5],S21,0xD62F105D); d = GG(d,a,b,c,x[k+10],S22,0x2441453); c = GG(c,d,a,b,x[k+15],S23,0xD8A1E681); b = GG(b,c,d,a,x[k+4],S24,0xE7D3FBC8);
      a = GG(a,b,c,d,x[k+9],S21,0x21E1CDE6); d = GG(d,a,b,c,x[k+14],S22,0xC33707D6); c = GG(c,d,a,b,x[k+3],S23,0xF4D50D87); b = GG(b,c,d,a,x[k+8],S24,0x455A14ED);
      a = GG(a,b,c,d,x[k+13],S21,0xA9E3E905); d = GG(d,a,b,c,x[k+2],S22,0xFCEFA3F8); c = GG(c,d,a,b,x[k+7],S23,0x676F02D9); b = GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
      a = HH(a,b,c,d,x[k+5],S31,0xFFFA3942); d = HH(d,a,b,c,x[k+8],S32,0x8771F681); c = HH(c,d,a,b,x[k+11],S33,0x6D9D6122); b = HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
      a = HH(a,b,c,d,x[k+1],S31,0xA4BEEA44); d = HH(d,a,b,c,x[k+4],S32,0x4BDECFA9); c = HH(c,d,a,b,x[k+7],S33,0xF6BB4B60); b = HH(b,c,d,a,x[k+10],S34,0xBEbfBC70);
      a = HH(a,b,c,d,x[k+13],S31,0x289B7EC6); d = HH(d,a,b,c,x[k],S32,0xEAA127FA); c = HH(c,d,a,b,x[k+3],S33,0xD4EF3085); b = HH(b,c,d,a,x[k+6],S34,0x4881D05);
      a = HH(a,b,c,d,x[k+9],S31,0xD9D4D039); d = HH(d,a,b,c,x[k+12],S32,0xE6DB99E5); c = HH(c,d,a,b,x[k+15],S33,0x1FA27CF8); b = HH(b,c,d,a,x[k+2],S34,0xC4AC5665);
      a = II(a,b,c,d,x[k],S41,0xF4292244); d = II(d,a,b,c,x[k+7],S42,0x432AFF97); c = II(c,d,a,b,x[k+14],S43,0xAB9423A7); b = II(b,c,d,a,x[k+5],S44,0xFC93A039);
      a = II(a,b,c,d,x[k+12],S41,0x655B59C3); d = II(d,a,b,c,x[k+3],S42,0x8F0CCC92); c = II(c,d,a,b,x[k+10],S43,0xFFEFF47D); b = II(b,c,d,a,x[k+1],S44,0x85845DD1);
      a = II(a,b,c,d,x[k+8],S41,0x6FA87E4F); d = II(d,a,b,c,x[k+15],S42,0xFE2CE6E0); c = II(c,d,a,b,x[k+6],S43,0xA3014314); b = II(b,c,d,a,x[k+13],S44,0x4E0811A1);
      a = II(a,b,c,d,x[k+4],S41,0xF7537E82); d = II(d,a,b,c,x[k+11],S42,0xBD3AF235); c = II(c,d,a,b,x[k+2],S43,0x2AD7D2BB); b = II(b,c,d,a,x[k+9],S44,0xEB86D391);
      a = addUnsigned(a,AA); b = addUnsigned(b,BB); c = addUnsigned(c,CC); d = addUnsigned(d,DD);
    }
    return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
  }

  // 正确的 WBI 签名映射表
  const MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

  // 生成正确的 mixin_key
  function getMixinKey(orig) {
      let temp = '';
      MIXIN_KEY_ENC_TAB.forEach(n => temp += orig[n]);
      return temp.slice(0, 32);
  }

  // 修正后的 WBI 签名生成
  function generateWbi(sortedParams, wts) {
      const { img_key, sub_key } = wbiKeys;
      if (!img_key || !sub_key) return '';
      const mixinKey = getMixinKey(img_key + sub_key);
      const query = sortedParams.join('&') + '&wts=' + wts;
      return md5(query + mixinKey);
  }

  // ========== 请求队列（节流 + 修正头部） ==========
  const fetchQueue = [];
  let fetchTimer = null;
  const FETCH_DELAY = 1500;

  // 将请求压入节流队列，避免短时间内触发过多接口调用。
  function enqueueFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      fetchQueue.push({ url, options, resolve, reject });
      processFetchQueue();
    });
  }

  // 按固定间隔依次处理请求队列，并处理频率限制重试。
  function processFetchQueue() {
    if (fetchTimer) return;
    if (fetchQueue.length === 0) return;

    const task = fetchQueue.shift();
    fetchTimer = setTimeout(async () => {
      fetchTimer = null;
      try {
        const res = await fetch(task.url, {
          credentials: 'include',
          headers: {
            'User-Agent': navigator.userAgent,
            'Referer': 'https://www.bilibili.com/',
            'Origin': 'https://www.bilibili.com',
            'Accept': 'application/json, text/plain, */*',
            ...(task.options.headers || {})
          },
          ...task.options
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.code !== 0) {
          if (json.code === -412 || json.code === -509 || json.code === -799) {
            console.warn('[清剿] 频率限制，等待后重试');
            fetchQueue.unshift(task);
            setTimeout(() => processFetchQueue(), 2000);
          } else {
            throw new Error(json.message || 'API error');
          }
        } else {
          task.resolve(json.data);
        }
      } catch (e) {
        task.reject(e);
      }
      processFetchQueue();
    }, FETCH_DELAY);
  }

  // 统一通过节流队列发起并返回 JSON 请求结果。
  async function requestJson(url, options) {
    return enqueueFetch(url, options);
  }

  // ========== 空间信息获取 ==========
  // 获取用户空间基础资料和活跃度统计信息。
  async function fetchSpaceInfo(uid) {
    // 并行请求两个接口，优化加载速度
    const [infoData, cardData] = await Promise.all([
      requestJson(`https://api.bilibili.com/x/space/acc/info?mid=${uid}`),
      requestJson(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`)
    ]);

    // cardData 包含 fans, attention, archive_count (视频数), like_num (获赞数)
    const card = cardData?.card || {};
    const stat = cardData || {};

    return {
      sign: normalizeText(infoData.sign || ''),
      name: infoData.name,
      // 🆕 从新接口更新用户统计数据
      following: card?.attention || 0,     // 关注数
      fans: card?.fans || 0,              // 粉丝数
      videos: stat?.archive_count || 0,   // 视频/专栏投稿总数 (替代播放数)
      likes: stat?.like_num || 0          // 获赞数
    };
  }

  // 获取用户置顶或最新动态，并附带动态类型概览。
  async function fetchLatestDynamic(uid) {
    try {
      const data = await requestJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`);
      const items = data.items || [];
      if (items.length === 0) return null;
      
      // 🆕 获取所有动态的类型信息
      const dynamicTypes = items.map(item => item.type || '');
      
      // 取置顶或最新动态
      const topItem = items.find(item => item.top === 1 || item.modules?.module_tag?.text === '置顶');
      const item = topItem || items[0];
      const desc = item.modules?.module_dynamic?.desc?.text || '';
      const dynamicId = item.id_str || item.basic?.comment_id_str || '';
      return {
        id: dynamicId,
        text: normalizeText(desc),
        // 🆕 新增：动态类型列表和动态总数
        types: dynamicTypes,
        totalCount: items.length
      };
    } catch (e) {
      console.warn('[清剿] 获取动态失败', e);
      return null;
    }
  }

  // 抓取最新动态下的少量评论文本，用于二次广告检测。
  async function fetchDynamicComments(dynamicId) {
    try {
      const data = await requestJson(`https://api.bilibili.com/x/v2/reply?type=17&oid=${dynamicId}&pn=1&ps=3`);
      const replies = data.replies || [];
      const texts = replies.map(r => normalizeText(r.content?.message || '')).filter(Boolean);
      return texts;
    } catch (e) {
      return [];
    }
  }

  // 获取用户最近一次投稿的视频标题。
  async function fetchLatestVideo(uid) {
    try {
      await fetchWbiKeys();
      const wts = Math.floor(Date.now() / 1000);
      const params = new URLSearchParams();
      params.set('mid', uid);
      params.set('ps', '1');
      params.set('tid', '0');
      params.set('pn', '1');
      params.set('keyword', '');
      params.set('order', 'pubdate');
      params.set('wts', wts);
      const sortKeys = Array.from(params.keys()).sort();
      const sortedParams = sortKeys.map(k => `${k}=${params.get(k)}`);
      const w_rid = generateWbi(sortedParams, wts);
      const url = `https://api.bilibili.com/x/space/wbi/arc/search?${sortedParams.join('&')}&w_rid=${w_rid}&wts=${wts}`;
      const data = await requestJson(url);
      const vlist = data.list?.vlist || [];
      if (vlist.length === 0) return null;
      return normalizeText(vlist[0].title || '');
    } catch (e) {
      console.warn('[清剿] 获取视频投稿失败', e);
      return null;
    }
  }

  // 判断文本里是否存在明显的引流词或联系方式信号。
  function hasAdKeywords(text) {
    if (!text) return false;
    const pattern = /(VX|wx|QQ|加群|扫码|进群|←戳|→戳|b23\.tv|https?:\/\/)/i;
    return pattern.test(text);
  }

  // 结合空间签名、动态、评论和投稿信息判断账号是否疑似广告号。
  async function checkUserProfile(uid) {
    const cached = profileCache.get(uid);
    if (cached && Date.now() - cached.time < CACHE_DURATION) return cached.result;

    if (pendingProfileChecks.has(uid)) {
      return pendingProfileChecks.get(uid);
    }

    const promise = (async () => {
      const details = { sign: null, dynamic: null, dynamicComments: [], video: null, empty: false };
      let isAd = false;
      try {
        const space = await fetchSpaceInfo(uid);
        console.log(`[清剿] UID ${uid} 空间信息:`, space);
        // 🆕 策略一：异常纯净画像识别
        // 1. 检查“三无”特征：粉丝数、获赞数、视频数都极低
        const isLowActivity = space.fans < 10 && space.likes < 10 && space.videos < 10;

        // 2. 检查动态内容：动态总数小于等于2且全部为纯转发
        const dynamic = await fetchLatestDynamic(uid);
        const isAllForward = dynamic && 
          dynamic.totalCount <= 2 && 
          dynamic.types.length > 0 && 
          dynamic.types.every(type => type === 'DYNAMIC_TYPE_FORWARD');

        // 如果满足任一条件，直接判定为广告号
        if (isLowActivity || isAllForward) {
          isAd = true;
          console.log('[清剿] 命中异常纯净画像识别规则');
        }
        details.sign = space.sign;
        console.log(`[清剿] UID ${uid} 签名:`, space.sign);
        if (hasAdKeywords(space.sign)) {
          isAd = true;
          console.log('[清剿] 签名命中引流词');
        }

        if (dynamic) {
          details.dynamic = dynamic.text;
          console.log(`[清剿] UID ${uid} 最新动态:`, dynamic.text);
          if (!isAd && hasAdKeywords(dynamic.text)) {
            isAd = true;
            console.log('[清剿] 动态命中引流词');
          }
          if (!isAd) {
            const comments = await fetchDynamicComments(dynamic.id);
            details.dynamicComments = comments;
            console.log(`[清剿] UID ${uid} 动态评论:`, comments);
            if (comments.some(c => hasAdKeywords(c))) {
              isAd = true;
              console.log('[清剿] 动态评论区命中引流词');
            }
          }
        }
        const videoTitle = await fetchLatestVideo(uid);
        if (videoTitle) {
          details.video = videoTitle;
          console.log(`[清剿] UID ${uid} 最新视频:`, videoTitle);
          if (!isAd && hasAdKeywords(videoTitle)) {
            isAd = true;
            console.log('[清剿] 视频标题命中引流词');
          }
        }

        if (!space.sign && !dynamic && !videoTitle) {
          isAd = true;
          details.empty = true;
          console.log('[清剿] 空间为空，判定为广告号');
        }
      } catch (e) {
        console.error(`[清剿] 空间检查失败 (UID ${uid})`, e);
        return { isAd: null, details, error: e.message };
      }
      const result = { isAd, details };
      profileCache.set(uid, { result, time: Date.now() });
      return result;
    })();

    pendingProfileChecks.set(uid, promise);
    try {
      return await promise;
    } finally {
      pendingProfileChecks.delete(uid);
    }
  }

  // ========== 评论区扫描与按钮逻辑 ==========
  // 把操作按钮优先挂载到评论底部的原生操作区中。
  function mountButtonToComment(item, btn) {
    const actionHost = item.actionHost || item.element;
    const sr = getOpenShadow(actionHost);
    if (!sr) return false;
    const actionButtonsHost = q(sr, '#footer bili-comment-action-buttons-renderer');
    const actionButtonsSr = getOpenShadow(actionButtonsHost);
    const pubdate = q(actionButtonsSr, '#pubdate');
    if (pubdate?.parentElement) { pubdate.insertAdjacentElement('afterend', btn); return true; }
    const ops = q(actionButtonsSr, '#footer') || q(actionButtonsSr, '[class*="action"]') || q(sr, '#footer .ops') || q(sr, '.reply-op') || q(sr, '[class*="oper"]') || q(sr, '#footer') || q(sr, '.sub-op');
    if (ops && ops !== sr && ops !== actionButtonsSr) { ops.appendChild(btn); return true; }
    return false;
  }

  // 合并并持久化新增关键词，同时同步给当前检测器实例。
  async function updateUserKeywords(newWords) {
    if (!newWords || newWords.length === 0) return;
    const { userKeywords = [] } = await chrome.storage.local.get('userKeywords');
    const updated = [...new Set([...userKeywords, ...newWords])];
    await chrome.storage.local.set({ userKeywords: updated });
    if (window.AdDetector && typeof window.AdDetector.setUserKeywords === 'function') window.AdDetector.setUserKeywords(updated);
  }

  // 在长文本评论场景下提示用户手动输入更精确的关键词。
  function promptForKeywords(item) {
    const baseHits = [];
    if (/戳这里|点这里|看我主页|私信|加微信|进群|资源/.test(item.text)) baseHits.push('疑似引流词：戳这里/看我主页');
    const userInput = prompt('⚠️ 该评论文本过长且无链接，为避免污染词库，\n请手动输入你想要拦截的核心关键词：\n（多个词请用空格隔开）', baseHits.join(' '));
    if (!userInput) return null;
    return userInput.trim().split(/\s+/).filter(k => k.length >= 2);
  }

  // 为评论添加“标记为广告”按钮，用于人工补充词库。
  function addMarkButton(item, el) {
    if (el.dataset.markBtnAdded === 'true' || el.dataset.adUserMarked === 'true') return;
    el.dataset.markBtnAdded = 'true';
    const btn = document.createElement('span');
    btn.className = 'bili-ad-learner-btn';
    btn.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; margin-left:4px; color:#fff; background:#6c757d; border-radius:4px; width:16px; height:16px; font-size:11px; line-height:1; cursor:pointer; user-select:none; z-index:999; opacity:0.8; padding:0;';
    btn.textContent = '📌';
    btn.title = '标记为广告，并将关键词加入永久词库';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const learnBtn = e.currentTarget;
      learnBtn.textContent = '⏳';
      learnBtn.style.background = '#5a6268';
      learnBtn.style.pointerEvents = 'none';
      let newWords = [];
      const hasLinkText = item.linkText && item.linkText.trim().length > 0;
      const sourceText = hasLinkText ? item.linkText : item.text;
      if (hasLinkText) newWords = extractKeywords(sourceText);
      else if (item.text.length <= 80) newWords = extractKeywords(item.text);
      else {
        newWords = promptForKeywords(item);
        if (!newWords) { learnBtn.textContent = '📌'; learnBtn.style.background = '#6c757d'; learnBtn.style.pointerEvents = 'auto'; return; }
      }
      if (newWords.length === 0) newWords = [sourceText.trim()].filter(t => t.length > 0);
      if (newWords.length === 0) { alert('未能提取到关键词。'); learnBtn.textContent = '📌'; learnBtn.style.background = '#6c757d'; learnBtn.style.pointerEvents = 'auto'; return; }
      await updateUserKeywords(newWords);
      el.dataset.adUserMarked = 'true';
      learnBtn.remove();
      const oldCleaner = el.querySelector('.bili-ad-cleaner-btn');
      if (oldCleaner) oldCleaner.remove();
      el.dataset.adCleanerProcessed = 'false';
      tryAddButton(item);
      scanAndMarkAllComments();
    });
    const actionHost = item.actionHost || el;
    const sr = getOpenShadow(actionHost);
    if (sr) {
      const ops = q(sr, '#footer .ops') || q(sr, '.reply-op') || q(sr, '[class*="oper"]') || q(sr, '#footer');
      if (ops) { ops.appendChild(btn); return; }
    }
    el.style.position = 'relative';
    btn.style.position = 'absolute'; btn.style.right = '80px'; btn.style.top = '50%'; btn.style.transform = 'translateY(-50%)';
    el.appendChild(btn);
  }

  // 为评论展示清剿按钮，并处理手动拉黑逻辑。
  function showCleanerButton(item, el, isHighLevel, rawLevel) {
    if (el.dataset.adCleanerProcessed === 'true' && el.querySelector('.bili-ad-cleaner-btn')) return;

    const btn = document.createElement('span');
    btn.className = 'bili-ad-cleaner-btn';
    btn.style.cssText = 'display:inline-flex; align-items:center; margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px; padding:2px 8px; font-size:12px; line-height:1.4; cursor:pointer; user-select:none; z-index:999; white-space:nowrap;';
    btn.textContent = '🚫 清剿';
    btn.title = isHighLevel ? '等级较高或等级未知，仅提示，不拉黑' : '直接拉黑';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isHighLevel) {
        const reason = (rawLevel === null || rawLevel === undefined) ? '该用户等级未知，可能为高等级账号或6级硬核会员。' : `该用户等级为 Lv${rawLevel}，可能为被盗的高级号。`;
        alert(`⚠️ ${reason}\n已跳过自动拉黑，请手动举报（右键评论 -> 举报）。`);
        return;
      }

      if (autoCleanActive && autoCleanQueue.some(q => q.uid === item.uid)) {
        alert('该账号已经在自动清剿队列中，无需手动操作。');
        return;
      }

      removeFromAutoCleanQueue(item.uid);

      try {
        const jctMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
        const biliJct = jctMatch ? jctMatch[1] : '';
        if (!biliJct) { alert('未登录 B站'); return; }
        const res = await fetch('https://api.bilibili.com/x/relation/modify', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Origin': 'https://www.bilibili.com', 'Referer': 'https://www.bilibili.com/' },
          body: new URLSearchParams({ fid: item.uid, act: '5', re_src: 11, csrf: biliJct })
        });
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.message);
        el.dataset.adBlocked = 'true';
        btn.textContent = '✅ 已清剿';
        btn.style.background = '#999';
        btn.style.pointerEvents = 'none';
      } catch (err) { alert('拉黑失败：' + err.message); }
    });

    if (mountButtonToComment(item, btn)) {
      el.dataset.adCleanerProcessed = 'true';
      item.cleanerBtn = btn;
    } else {
      el.style.position = 'relative';
      btn.style.position = 'absolute'; btn.style.right = '8px'; btn.style.top = '50%'; btn.style.transform = 'translateY(-50%)';
      el.appendChild(btn);
      el.dataset.adCleanerProcessed = 'true';
      item.cleanerBtn = btn;
    }
  }

  // 将疑似广告账号加入自动清剿队列，避免重复入队。
  function enqueueAutoClean(item) {
    if (autoCleanQueue.some(queued => queued.uid === item.uid)) return;
    if (item.element?.dataset?.adBlocked === 'true') return;
    autoCleanQueue.push(item);
    updateAutoCleanPanel();
    console.log('[清剿] 自动入队:', item.name, '(Lv' + item.level + ')');
  }

  // 从自动清剿队列中移除指定用户。
  function removeFromAutoCleanQueue(uid) {
    const index = autoCleanQueue.findIndex(q => q.uid === uid);
    if (index !== -1) {
      autoCleanQueue.splice(index, 1);
      updateAutoCleanPanel();
    }
  }

  // 评估评论风险，并决定是否展示按钮或触发空间复核。
  async function tryAddButton(item) {
    const el = item.element;
    if (!el) return;
    if (!window.AdDetector || typeof window.AdDetector.analyze !== 'function') return;

    const alreadyHasCleaner = el.dataset.adCleanerProcessed === 'true';
    const isUserMarked = el.dataset.adUserMarked === 'true';
    const alreadyBlocked = el.dataset.adBlocked === 'true';

    if (alreadyHasCleaner || alreadyBlocked) {
      const alreadyHasMark = el.dataset.markBtnAdded === 'true';
      if (!alreadyHasMark && !isUserMarked) addMarkButton(item, el);
      return;
    }
    // console.log('[清剿] 评估评论:', item.text, '(UID ' + item.uid + ', Lv' + item.level + ')');

    let score = 0;
    if (isUserMarked) score = 100;
    else score = window.AdDetector.analyze({ content: item.text, level: item.level, avatarUrl: '' });

    const rawLevel = item.level;
    const isHighLevel = rawLevel === null || rawLevel === undefined || rawLevel >= 4;
    const hasStrongSignal = window.AdDetector.hasStrongAdSignals ? window.AdDetector.hasStrongAdSignals(item.text) : false;
    const needProfileCheck = !hasStrongSignal && !isUserMarked && score >= 40;

    if (score >= 40 || isUserMarked) {
      if (hasStrongSignal || isUserMarked) {
        showCleanerButton(item, el, isHighLevel, rawLevel);
        if (!isHighLevel && !alreadyBlocked) enqueueAutoClean(item);
      } else if (needProfileCheck) {
        if (el.dataset.adProfilePending === 'true') return;
        el.dataset.adProfilePending = 'true';

        const placeholder = document.createElement('span');
        placeholder.className = 'bili-ad-cleaner-placeholder';
        placeholder.style.cssText = 'display:inline-flex; align-items:center; margin-left:12px; color:#bfc7d5; background:rgba(255,255,255,0.06); border-radius:4px; padding:2px 8px; font-size:12px; white-space:nowrap;';
        placeholder.textContent = '⏳ 检测中';
        mountButtonToComment(item, placeholder) || el.appendChild(placeholder);

        checkUserProfile(item.uid).then(({ isAd, error }) => {
          console.log(`[清剿] 空间检测结果 (UID ${item.uid}):`, isAd ? '疑似广告' : '正常账号', error ? `(错误: ${error})` : '');
          if (placeholder) placeholder.remove();
          delete el.dataset.adProfilePending;

          if (error) {
            console.warn('[清剿] 空间检测失败，回退显示清剿按钮', error);
            // 回退：按原规则显示按钮
            showCleanerButton(item, el, false, rawLevel);
            if (!isHighLevel && !el.dataset.adBlocked) enqueueAutoClean(item);
          } else if (isAd) {
            console.log('[清剿] 空间检测确认广告，显示按钮');
            showCleanerButton(item, el, false, rawLevel);
            if (!isHighLevel && !el.dataset.adBlocked) enqueueAutoClean(item);
          } else {
            console.log('[清剿] 空间正常，取消广告标记');
            // 🔧 关键修复：标记为已处理，防止重复扫描
            el.dataset.adCleanerProcessed = 'true';
          }
        }).catch(err => {
          if (placeholder) placeholder.remove();
          delete el.dataset.adProfilePending;
          console.error('[清剿] 空间检测异常，回退显示按钮', err);
          showCleanerButton(item, el, false, rawLevel);
          if (!isHighLevel && !el.dataset.adBlocked) enqueueAutoClean(item);
        });
      }
    }

    const alreadyHasMark = el.dataset.markBtnAdded === 'true';
    if (!alreadyHasMark && !isUserMarked) {
      addMarkButton(item, el);
    }
  }

  // ========== 面板与自动 ==========
  // 构建右侧自动清剿面板，并缓存关键节点引用。
  function buildAutoCleanPanel() {
    if (autoCleanPanel) return autoCleanPanel;
    const panel = document.createElement('div');
    panel.id = 'ad-clean-auto-panel';
    panel.style.cssText = 'position:fixed; right:16px; top:96px; width:300px; max-height:50vh; z-index:999999; background:rgba(18,18,24,0.95); color:#f5f7fa; border:1px solid rgba(255,255,255,0.1); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.4); overflow:hidden; font-size:13px; display:none;';
    panel.innerHTML = `
      <div style="padding:12px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:700;">🤖 自动清剿队列</span>
        <span id="ad-clean-queue-count" style="font-size:12px; background:rgba(255,255,255,0.08); padding:2px 8px; border-radius:999px;">0</span>
      </div>
      <div style="max-height:30vh; overflow-y:auto;" id="ad-clean-queue-list"></div>
      <div id="ad-clean-current" style="padding:10px; border-top:1px solid rgba(255,255,255,0.08); font-size:12px; color:#bfc7d5;"></div>
    `;
    document.body.appendChild(panel);
    autoCleanPanel = panel;
    autoCleanListEl = panel.querySelector('#ad-clean-queue-list');
    autoCleanCurrentEl = panel.querySelector('#ad-clean-current');
    return panel;
  }

  // 刷新自动清剿面板的队列数量、当前项和显隐状态。
  function updateAutoCleanPanel() {
    if (!autoCleanPanel) return;
    const countEl = autoCleanPanel.querySelector('#ad-clean-queue-count');
    if (countEl) countEl.textContent = autoCleanQueue.length;
    if (autoCleanListEl) {
      autoCleanListEl.innerHTML = autoCleanQueue.map((item, idx) => {
        const isCurrent = idx === 0;
        return `<div style="padding:6px 10px; background:${isCurrent?'rgba(251,114,153,0.15)':'transparent'}; display:flex; justify-content:space-between; align-items:center; font-size:12px;">
          <span style="color:${isCurrent?'#fb7299':'#d6dbe3'};">${item.name} (Lv${item.level})</span>
          <span style="color:#888;">${item.text.slice(0,20)}…</span>
        </div>`;
      }).join('');
    }
    if (autoCleanCurrentEl) {
      const current = autoCleanQueue[0];
      autoCleanCurrentEl.textContent = current ? `当前：${current.name} (Lv${current.level ?? '?'})` : '队列已空，等待新评论...';
    }
    autoCleanPanel.style.display = autoCleanActive ? 'block' : 'none';
  }

  // 依次处理自动清剿队列中的账号拉黑请求。
  async function processAutoCleanQueue() {
    if (!autoCleanActive || autoCleanQueue.length === 0) { updateAutoCleanPanel(); return; }
    const item = autoCleanQueue[0];
    updateAutoCleanPanel();
    try {
      const jctMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
      const biliJct = jctMatch ? jctMatch[1] : '';
      if (!biliJct) throw new Error('未登录');
      const res = await fetch('https://api.bilibili.com/x/relation/modify', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Origin': 'https://www.bilibili.com', 'Referer': 'https://www.bilibili.com/' },
        body: new URLSearchParams({ fid: item.uid, act: '5', re_src: 11, csrf: biliJct })
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.message);
      if (item.cleanerBtn) {
        item.cleanerBtn.textContent = '✅ 已清剿';
        item.cleanerBtn.style.background = '#999';
        item.cleanerBtn.style.pointerEvents = 'none';
      } else if (item.element) {
        const actionHost = item.actionHost || item.element;
        const sr = getOpenShadow(actionHost);
        if (sr) {
          const cleaner = sr.querySelector('.bili-ad-cleaner-btn');
          if (cleaner) {
            cleaner.textContent = '✅ 已清剿';
            cleaner.style.background = '#999';
            cleaner.style.pointerEvents = 'none';
          }
        }
      }
      if (item.element) item.element.dataset.adBlocked = 'true';
      console.log('[清剿] 自动清剿成功:', item.name);
      autoCleanQueue.shift();
      updateAutoCleanPanel();
    } catch (err) {
      console.error('[清剿] 自动清剿失败:', item.uid, err);
      autoCleanQueue.shift();
      updateAutoCleanPanel();
    }
  }

  // 开启自动清剿定时器，并显示队列面板。
  function startAutoClean() {
    if (autoCleanActive) return;
    autoCleanActive = true;
    buildAutoCleanPanel();
    updateAutoCleanPanel();
    autoCleanTimer = setInterval(processAutoCleanQueue, 1000);
    console.log('[清剿] 自动清剿已启动');
  }

  // 停止自动清剿，但保留当前待处理队列。
  function stopAutoClean() {
    autoCleanActive = false;
    if (autoCleanTimer) { clearInterval(autoCleanTimer); autoCleanTimer = null; }
    if (autoCleanPanel) autoCleanPanel.style.display = 'none';
    console.log('[清剿] 自动清剿已停止（队列保留）');
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startAutoClean') {
      startAutoClean();
      sendResponse({ ok: true });
    } else if (request.action === 'stopAutoClean') {
      stopAutoClean();
      sendResponse({ ok: true });
    } else if (request.action === 'getAutoCleanStatus') {
      sendResponse({ active: autoCleanActive });
    } else if (request.action === 'updateKeywords') {
      initUserKeywords();
      sendResponse({ ok: true });
    }
  });

  // 递归收集评论区域内所有需要监听的 Shadow Root。
  function collectCommentShadowRoots(root, visited = new WeakSet(), acc = []) {
    if (!root || visited.has(root)) return acc;
    visited.add(root);
    acc.push(root);
    const hosts = qa(root, COMMENT_SHADOW_HOST_SELECTOR);
    for (const host of hosts) {
      const sr = getOpenShadow(host);
      if (sr) collectCommentShadowRoots(sr, visited, acc);
    }
    return acc;
  }

  // 汇总页面上当前可见的所有评论项数据。
  function getAllCommentItems() {
    const host = getCommentsHost();
    const hostShadow = getOpenShadow(host);
    if (!hostShadow) return [];
    const roots = collectCommentShadowRoots(hostShadow);
    const seenTargets = new WeakSet();
    const items = [];
    for (const root of roots) {
      const targets = [...qa(root, 'bili-comment-thread-renderer'), ...qa(root, 'bili-comment-reply-renderer')];
      for (const target of targets) {
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        const item = extractCommentDataFromTarget(target);
        if (item) items.push(item);
      }
    }
    return items;
  }

  // 扫描全部评论，并为符合条件的评论补上操作按钮。
  function scanAndMarkAllComments() {
    const items = getAllCommentItems();
    if (items.length > 0) items.forEach(tryAddButton);
  }

  // 用短延迟合并多次扫描请求，降低频繁变更带来的开销。
  function scheduleFullScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => { scanTimer = null; scanAndMarkAllComments(); }, 50);
  }

  // 遍历当前根节点下的评论宿主，并继续向内监听其 Shadow DOM。
  function observeNestedCommentShadows(root) {
    const hosts = qa(root, COMMENT_SHADOW_HOST_SELECTOR);
    for (const host of hosts) {
      const sr = getOpenShadow(host);
      if (sr) observeShadowRootRecursively(sr);
    }
  }

  // 递归监听评论 Shadow Root 的变更，并在变化后重新扫描评论。
  function observeShadowRootRecursively(root) {
    if (!root || observedShadowRoots.has(root)) return;
    observedShadowRoots.add(root);
    observeNestedCommentShadows(root);
    scheduleFullScan();
    const observer = new MutationObserver(() => {
      observeNestedCommentShadows(root);
      scheduleFullScan();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  // 初始化用户自定义关键词，并注入到广告检测器中。
  async function initUserKeywords() {
    const { userKeywords = [] } = await chrome.storage.local.get('userKeywords');
    if (window.AdDetector && typeof window.AdDetector.setUserKeywords === 'function') window.AdDetector.setUserKeywords(userKeywords);
  }

  // 从评论宿主开始建立 Shadow DOM 监听链路。
  function startObservingShadow() {
    const host = getCommentsHost();
    if (!host) return;
    const sr = getOpenShadow(host);
    if (!sr) { setTimeout(startObservingShadow, 1000); return; }
    observeShadowRootRecursively(sr);
  }

  // 等待评论区挂载完成后，初始化词库并启动评论监听。
  async function waitForHost() {
    await initUserKeywords();
    if (getCommentsHost()) { startObservingShadow(); return; }
    const bodyObserver = new MutationObserver(() => {
      if (getCommentsHost()) { bodyObserver.disconnect(); startObservingShadow(); }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    waitForHost();
  } else {
    window.addEventListener('load', waitForHost);
  }
})();
