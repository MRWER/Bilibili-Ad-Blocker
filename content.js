// content.js – 重构版（队列独立管理，防并发冲突）
(function () {
  'use strict';
  console.log('[清剿] content.js 已注入 (重构版)');

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

  // 自动清剿状态
  let autoCleanActive = false;
  let autoCleanQueue = [];
  let autoCleanTimer = null;
  let autoCleanPanel = null;
  let autoCleanListEl = null;
  let autoCleanCurrentEl = null;

  // ========== 工具函数 ==========
  function getOpenShadow(el) {
    try { return el && el.shadowRoot ? el.shadowRoot : null; } catch { return null; }
  }
  function q(root, sel) { return root && root.querySelector ? root.querySelector(sel) : null; }
  function qa(root, sel) { return root && root.querySelectorAll ? [...root.querySelectorAll(sel)] : []; }
  function normalizeText(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function getTagName(el) { return el?.tagName ? String(el.tagName).toUpperCase() : ''; }

  // 通用数据提取
  function getCommentData(el) {
    if (!el) return null;
    const vueInstance = el.__vue__ || el._vue__ || el.__vue_app__ || el._data || null;
    if (vueInstance) return vueInstance.data || vueInstance._data || vueInstance;
    if (el.__data) return el.__data;
    return null;
  }

  // 关键词提取（中文、英文、链接）
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
    const cnStopwords = new Set([
      '可以','什么','怎么','为什么','觉得','还是','但是','因为','所以','如果','不过','只是',
      '然后','已经','比较','非常','真的','这个','那个','一些','一个','自己','他们','我们',
      '你们','没有','知道','出来','起来','过来','进去','就是','也是','不是','还有','的话',
      '而已','而且','并且'
    ]);
    const cnResult = [...chineseWords].filter(w => w.length >= 2 && !cnStopwords.has(w));
    const englishWords = normalized.match(/[a-zA-Z]{2,}/g) || [];
    const enStopwords = new Set([
      'a','an','the','is','are','was','were','be','been','being','have','has','had',
      'do','does','did','will','would','could','should','may','might','shall','can',
      'need','dare','ought','used','to','of','in','for','on','with','at','by','from',
      'as','into','through','during','before','after','above','below','between','under',
      'again','further','then','once','here','there','when','where','why','how','all',
      'both','each','few','more','most','other','some','such','no','nor','not','only',
      'own','same','so','than','too','very','and','but','or','if','because','as',
      'until','while','this','that','these','those','am','it','its', 'he','she','they',
      'we','you','i','me','my','your','his','her','our','their','mine','yours','hers'
    ]);
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

  // 增强版等级提取
  function extractLevelFromData(commentData) {
    if (!commentData) return null;
    const candidates = [
      commentData?.member?.level_info?.current_level,
      commentData?.member?.level_info?.currentLevel,
      commentData?.reply_control?.user_level,
      commentData?.member?.level,
      commentData?.user_level,
      commentData?.level,
      commentData?.info?.level,
      commentData?.info?.level_info?.current_level,
      commentData?.content?.member?.level_info?.current_level
    ];
    for (const candidate of candidates) {
      const level = Number(candidate);
      if (Number.isFinite(level) && level > 0 && level <= 6) return level;
    }
    if (commentData?.member?.is_hardcore_vip === true || 
        commentData?.member?.is_hardcore_vip === 1) return 6;
    return null;
  }

  function extractLevelFromRenderer(commentRenderer) {
    const dataLevel = extractLevelFromData(getCommentData(commentRenderer));
    if (dataLevel != null) return dataLevel;
    const sr = getOpenShadow(commentRenderer);
    if (!sr) return null;
    
    const infoHost = q(sr, 'bili-comment-user-info');
    if (infoHost) {
      const infoSr = getOpenShadow(infoHost);
      if (infoSr) {
        const levelImg = q(infoSr, '#user-level img') || 
                        q(infoSr, '.level-icon') || 
                        q(infoSr, '[class*="level"] img');
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

  function extractTextFromRichTextHost(richHost) {
    if (!richHost) return '';
    const sr = getOpenShadow(richHost);
    const el = q(sr, '#contents') || q(sr, 'p#contents') || richHost;
    return normalizeText(el?.innerText || el?.textContent || '');
  }

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

  async function updateUserKeywords(newWords) {
    if (!newWords || newWords.length === 0) return;
    const { userKeywords = [] } = await chrome.storage.local.get('userKeywords');
    const updated = [...new Set([...userKeywords, ...newWords])];
    await chrome.storage.local.set({ userKeywords: updated });
    if (window.AdDetector && typeof window.AdDetector.setUserKeywords === 'function') window.AdDetector.setUserKeywords(updated);
  }

  function promptForKeywords(item) {
    const baseHits = [];
    if (/戳这里|点这里|看我主页|私信|加微信|进群|资源/.test(item.text)) baseHits.push('疑似引流词：戳这里/看我主页');
    const userInput = prompt('⚠️ 该评论文本过长且无链接，为避免污染词库，\n请手动输入你想要拦截的核心关键词：\n（多个词请用空格隔开）', baseHits.join(' '));
    if (!userInput) return null;
    return userInput.trim().split(/\s+/).filter(k => k.length >= 2);
  }

  function addMarkButton(item, el) {
    if (el.dataset.markBtnAdded === 'true' || el.dataset.adUserMarked === 'true') return;
    el.dataset.markBtnAdded = 'true';
    const btn = document.createElement('span');
    btn.className = 'bili-ad-learner-btn';
    btn.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; margin-left:4px; color:#fff; background:#6c757d; border-radius:4px; width:22px; height:22px; font-size:13px; line-height:1; cursor:pointer; user-select:none; z-index:999; opacity:0.8; padding:0;';
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

  // ========== 清剿按钮与队列管理 ==========
  function tryAddButton(item) {
    const el = item.element;
    if (!el) return;
    if (!window.AdDetector || typeof window.AdDetector.analyze !== 'function') return;

    const alreadyHasCleaner = el.dataset.adCleanerProcessed === 'true';
    const isUserMarked = el.dataset.adUserMarked === 'true';
    const alreadyBlocked = el.dataset.adBlocked === 'true';
    
    let score = 0;
    if (isUserMarked) score = 100;
    else score = window.AdDetector.analyze({ content: item.text, level: item.level, avatarUrl: '' });
    
    const rawLevel = item.level;
    const isHighLevel = rawLevel === null || rawLevel === undefined || rawLevel >= 4;
    const isUnknownLevel = rawLevel === null || rawLevel === undefined;
    
    if (!alreadyHasCleaner && (score >= 40 || isUserMarked)) {
      const btn = document.createElement('span');
      btn.className = 'bili-ad-cleaner-btn';
      btn.style.cssText = 'display:inline-flex; align-items:center; margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px; padding:2px 8px; font-size:12px; line-height:1.4; cursor:pointer; user-select:none; z-index:999; white-space:nowrap;';
      btn.textContent = '🚫 清剿';
      btn.title = isHighLevel ? '等级较高或等级未知，仅提示，不拉黑' : '直接拉黑';
      
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isHighLevel) {
          const reason = isUnknownLevel ? 
            '该用户等级未知，可能为高等级账号或6级硬核会员。' : 
            `该用户等级为 Lv${rawLevel}，可能为被盗的高级号。`;
          alert(`⚠️ ${reason}\n已跳过自动拉黑，请手动举报（右键评论 -> 举报）。`);
          return;
        }

        // 自动清剿开启时，禁止手动清剿队列中的账号
        if (autoCleanActive && autoCleanQueue.some(q => q.uid === item.uid)) {
          alert('该账号已经在自动清剿队列中，无需手动操作。');
          return;
        }

        // 手动清剿：先从队列中移除以防并发
        removeFromAutoCleanQueue(item.uid);

        // 执行拉黑
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
        } catch (err) { 
          alert('拉黑失败：' + err.message); 
        }
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
    
    // 无条件将低等级未拉黑账号加入队列（为自动清剿准备）
    if (!isHighLevel && !alreadyBlocked && !el.dataset.adBlocked) {
      enqueueAutoClean(item);
    }

    // 标记按钮
    const alreadyHasMark = el.dataset.markBtnAdded === 'true';
    if (!alreadyHasMark && !isUserMarked) {
      addMarkButton(item, el);
    }
  }

  function enqueueAutoClean(item) {
    if (autoCleanQueue.some(queued => queued.uid === item.uid)) return;
    if (item.element?.dataset?.adBlocked === 'true') return;
    autoCleanQueue.push(item);
    updateAutoCleanPanel();
    console.log('[清剿] 自动入队:', item.name, '(Lv' + item.level + ')');
  }

  function removeFromAutoCleanQueue(uid) {
    const index = autoCleanQueue.findIndex(q => q.uid === uid);
    if (index !== -1) {
      autoCleanQueue.splice(index, 1);
      updateAutoCleanPanel();
    }
  }

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
      autoCleanCurrentEl.textContent = current ? 
        `当前：${current.name} (Lv${current.level ?? '?'})` : 
        '队列已空，等待新评论...';
    }
    autoCleanPanel.style.display = autoCleanActive ? 'block' : 'none';
  }

  async function processAutoCleanQueue() {
    if (!autoCleanActive || autoCleanQueue.length === 0) {
      updateAutoCleanPanel();
      return;
    }
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
      // 更新按钮状态（通过引用或备用查找）
      if (item.cleanerBtn) {
        item.cleanerBtn.textContent = '✅ 已清剿';
        item.cleanerBtn.style.background = '#999';
        item.cleanerBtn.style.pointerEvents = 'none';
      } else if (item.element) {
        // 备用查找
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

  // 扫描已存在的评论并加入队列（补漏）
  function addExistingItemsToQueue() {
    const items = getAllCommentItems();
    for (const item of items) {
      const el = item.element;
      if (!el) continue;
      const alreadyBlocked = el.dataset.adBlocked === 'true';
      const isHighLevel = (item.level === null || item.level === undefined || item.level >= 4);
      const hasCleanerButton = el.dataset.adCleanerProcessed === 'true';
      if (!alreadyBlocked && !isHighLevel && hasCleanerButton) {
        enqueueAutoClean(item);
      }
    }
  }

  function startAutoClean() {
    if (autoCleanActive) return;
    autoCleanActive = true;
    buildAutoCleanPanel();
    updateAutoCleanPanel();
    autoCleanTimer = setInterval(processAutoCleanQueue, 1000);
    // addExistingItemsToQueue();  // 补充现有评论
    console.log('[清剿] 自动清剿已启动');
  }

  function stopAutoClean() {
    autoCleanActive = false;
    if (autoCleanTimer) { clearInterval(autoCleanTimer); autoCleanTimer = null; }
    if (autoCleanPanel) autoCleanPanel.style.display = 'none';
    // 不清空队列，保留以实时积累
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
    }
  });

  function scanAndMarkAllComments() {
    const items = getAllCommentItems();
    if (items.length > 0) {
      items.forEach(tryAddButton);
    }
  }

  function scheduleFullScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => { scanTimer = null; scanAndMarkAllComments(); }, 50);
  }

  function observeNestedCommentShadows(root) {
    const hosts = qa(root, COMMENT_SHADOW_HOST_SELECTOR);
    for (const host of hosts) {
      const sr = getOpenShadow(host);
      if (sr) observeShadowRootRecursively(sr);
    }
  }

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

  async function initUserKeywords() {
    const { userKeywords = [] } = await chrome.storage.local.get('userKeywords');
    if (window.AdDetector && typeof window.AdDetector.setUserKeywords === 'function') window.AdDetector.setUserKeywords(userKeywords);
  }

  function startObservingShadow() {
    const host = getCommentsHost();
    if (!host) return;
    const sr = getOpenShadow(host);
    if (!sr) { setTimeout(startObservingShadow, 1000); return; }
    observeShadowRootRecursively(sr);
  }

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