// content.js – 空间二次验证完整版（修正 WBI + 修复回退逻辑）
(function () {
    "use strict";
    console.log("[清剿] content.js 已注入 (空间验证修正版)");

    const COMMENT_SHADOW_HOST_SELECTOR = [
        "bili-comment-thread-renderer",
        "bili-comment-renderer",
        "bili-comment-replies-renderer",
        "bili-comment-reply-renderer",
        "bili-comment-user-info",
        "bili-rich-text",
        "bili-comment-action-buttons-renderer",
    ].join(", ");

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
    const pendingProfileChecks = new Map(); // uid -> Promise

    // ========== 工具函数 ==========
    // 安全获取元素的开放式 Shadow Root，避免访问异常打断流程。
    function getOpenShadow(el) {
        try {
            return el && el.shadowRoot ? el.shadowRoot : null;
        } catch {
            return null;
        }
    }
    // 在指定根节点下查询单个元素。
    function q(root, sel) {
        return root && root.querySelector ? root.querySelector(sel) : null;
    }
    // 在指定根节点下查询多个元素并转为数组。
    function qa(root, sel) {
        return root && root.querySelectorAll
            ? [...root.querySelectorAll(sel)]
            : [];
    }
    // 统一清洗文本中的空白字符，便于后续匹配和比较。
    function normalizeText(text) {
        return String(text || "")
            .replace(/\s+/g, " ")
            .trim();
    }
    // 获取元素标签名，并统一转换为大写格式。
    function getTagName(el) {
        return el?.tagName ? String(el.tagName).toUpperCase() : "";
    }

    // ─── extractKeywords 辅助常量（模块顶层，避免每次调用重建）──────────────

    // 广告语义短语模式：优先从文本中提取有明确意义的引流词组（比 n-gram 精度高得多）
    const _KW_SEMANTIC_PATTERNS = [
        /(?:加|找|扫)?(?:微|薇|威)?信[\s:：]?[a-zA-Z0-9_\-]{4,20}/g, // 微信号格式
        /[qQｑＱ]{1,2}[\s:：]?\d{5,12}/g, // QQ 号
        /(?:进|加|入)?群[\s:：]?\d{6,12}/g, // 群号
        /[vVwW][xX][\s:：]?[a-zA-Z0-9_]{4,20}/g, // VX/WX 账号
        /[Tt][Gg][\s:：@]?[a-zA-Z0-9_]{4,20}/g, // Telegram 账号
        /[Dd]{2}[\s:：]?\d{4,}/g, // DD+数字引流
        /(?:私信|私聊|找我|加我|联系我).{0,6}(?:领|取|拿|要|获取)/g,
        /(?:免费|白嫖|干货|福利|资源).{0,8}(?:私|群|戳|点|来|加)/g,
        /(?:回复|评论|扣).{0,3}\d{1,4}.{0,6}(?:领|取|发|送)/g,
        /(?:看|去|点).{0,2}(?:主页|简介|空间|动态).{0,4}(?:有|领|取|找)/g,
    ];

    // 中文高信号字符：广告评论中承载"动作/渠道"语义的核心字，仅在这些字周边提取 bigram
    const _KW_CN_SIGNAL_CHARS = new Set([
        ..."加进私看扣戳滴群微联发领取拿免赚佣单",
    ]);

    // 中文停用单字（用于净化 bigram 原料，避免生成纯停用字的无意义词对）
    const _KW_CN_STOP_CHARS = new Set([
        ..."的了就也是在和有我你他她它啊呀吗呢吧哦哈嗯对好嘛哇喔",
    ]);

    // 中文停用双字词
    const _KW_CN_STOP_WORDS = new Set([
        '可以','什么','怎么','为什么','觉得','还是','但是','因为','所以','如果',
        '不过','只是','然后','已经','比较','非常','真的','这个','那个','一些',
        '一个','自己','他们','我们','你们','没有','知道','出来','起来','过来',
        '进去','就是','也是','不是','还有','的话','而已','而且','并且','一直',
        '一样','感觉','现在','之后','之前','其实','不会','不要','一下','没啥',
        '有点','有些','有没','好像','应该','只有','虽然','即使',
    ]);

    // 英文停用词（扩充版）
    const _KW_EN_STOP_WORDS = new Set([
        'a','an','the','is','are','was','were','be','been','being','have','has',
        'had','do','does','did','will','would','could','should','may','might',
        'shall','can','to','of','in','for','on','with','at','by','from','as',
        'into','through','before','after','between','under','then','once','here',
        'there','when','where','why','how','all','both','each','few','more',
        'most','other','some','such','no','nor','not','only','same','so','than',
        'too','very','and','but','or','if','because','until','while','this',
        'that','these','those','am','it','its','he','she','they','we','you',
        'i','me','my','your','his','her','our','their','just','also','even',
        'over','about','like','well','what','make','them','who','one','two',
        'get','go','see','now','new','say','take','want','use','find','give',
    ]);

    /**
     * 从广告评论文本中提取高质量关键词，用于补充用户自定义词库。
     *
     * 四阶段策略（由高到低优先级）：
     *   1. 预归一化：全角→半角、零宽字符清除、插空还原
     *   2. 语义短语提取：直接命中引流结构（最具拦截价值）
     *   3. 信号字周边 bigram：仅在高风险字符附近提取双字组合，非全量 n-gram
     *   4. 英文词 + URL 关键段提取
     *   后处理：噪声过滤 → 子串去冗余 → 截断至最多 20 个
     *
     * 对比原方案的改进：
     *   - 原方案对全文做 2/3/4-gram，一条评论可生成数百词条，噪声极大
     *   - 新方案优先语义匹配，bigram 只在信号字周边提取，词条数受控（通常 5-15 个）
     *   - 更彻底的预归一化，避免全角/插空等变体词条漏网
     *   - 子串去冗余：有"加微信群"时不再单独保留"微信""加微"等子串
     */
    function extractKeywords(text) {
        if (!text) return [];

        // ── 阶段 1：预归一化 ────────────────────────────────────────────────────
        let norm = normalizeText(text)
            .replace(/[Ａ-Ｚ]/g, (c) =>
                String.fromCharCode(c.charCodeAt(0) - 65248 + 65),
            )
            .replace(/[ａ-ｚ]/g, (c) =>
                String.fromCharCode(c.charCodeAt(0) - 65248 + 97),
            )
            .replace(/[０-９]/g, (c) =>
                String.fromCharCode(c.charCodeAt(0) - 65248 + 48),
            )
            .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
            .replace(/微\s+信/g, "微信")
            .replace(/[Qq]\s+[Qq]/g, "QQ")
            .replace(/扣\s*扣/g, "QQ")
            .replace(/[vVwW][xX]/g, "微信")
            .trim();

        const result = new Set();

        // ── 阶段 2：广告语义短语提取（优先级最高）──────────────────────────────
        for (const pattern of _KW_SEMANTIC_PATTERNS) {
            // 注意：同一个 global regex 需重置 lastIndex 或每次 clone；这里用 source 重建避免状态问题
            const re = new RegExp(pattern.source, pattern.flags);
            let m;
            while ((m = re.exec(norm)) !== null) {
                const phrase = m[0].replace(/\s/g, "").trim();
                if (phrase.length >= 2) result.add(phrase);
            }
        }

        // ── 阶段 3：信号字周边中文 bigram（定向提取，非全量）───────────────────
        const chineseOnly = norm.replace(/[^\u4e00-\u9fa5]/g, "");
        // 先剔除停用单字，净化 bigram 原料
        const cleanCN = chineseOnly
            .split("")
            .filter((c) => !_KW_CN_STOP_CHARS.has(c))
            .join("");

        for (let i = 0; i < cleanCN.length; i++) {
            if (!_KW_CN_SIGNAL_CHARS.has(cleanCN[i])) continue;
            // 提取以信号字为中心的 2-gram 和 3-gram（左移一位 + 当前位）
            for (const start of [i - 1, i]) {
                if (start < 0) continue;
                for (const len of [2, 3]) {
                    if (start + len > cleanCN.length) continue;
                    const chunk = cleanCN.substring(start, start + len);
                    if (!_KW_CN_STOP_WORDS.has(chunk)) result.add(chunk);
                }
            }
        }

        // 若语义短语和信号字 bigram 均无结果，对全文做纯 bigram 兜底
        // （仅对长度 ≤ 30 的短评生效，避免长文本产生大量噪声词）
        if (result.size === 0 && cleanCN.length <= 30) {
            for (let i = 0; i < cleanCN.length - 1; i++) {
                const bigram = cleanCN.substring(i, i + 2);
                if (!_KW_CN_STOP_WORDS.has(bigram)) result.add(bigram);
            }
        }

        // ── 阶段 4a：英文词提取 ─────────────────────────────────────────────────
        // 先剥离 URL，防止域名/参数污染词库
        const normNoUrl = norm.replace(/https?:\/\/\S+/g, " ");
        const englishWords = normNoUrl.match(/[a-zA-Z]{3,}/g) || [];
        for (const w of [...new Set(englishWords)]) {
            const lw = w.toLowerCase();
            if (!_KW_EN_STOP_WORDS.has(lw)) result.add(lw);
        }

        // ── 阶段 5：后处理 ──────────────────────────────────────────────────────
        let words = [...result].filter(
            (kw) =>
                kw.length >= 2 && // 最短两字
                !/^\d{1,3}$/.test(kw) && // 纯短数字无意义
                !/^(.)\1+$/.test(kw), // 重复单字无意义（如"哈哈哈"→"哈哈"）
        );

        // 子串去冗余：若较短词已被较长词完整包含，则舍弃较短词
        // 例：有"加微信群"时，"微信"和"加微"作为冗余词被移除
        words.sort((a, b) => b.length - a.length);
        const deduped = [];
        for (const kw of words) {
            if (!deduped.some((longer) => longer.includes(kw))) {
                deduped.push(kw);
            }
        }

        // 最多返回 20 个关键词，防止少数超长评论污染词库
        const final = deduped.slice(0, 20);

        if (final.length === 0 && norm.length < 20) return [norm];
        return final;
    }

    // 评论区宿主
    function getCommentsHost() {
        const direct = document.querySelector("bili-comments");
        if (direct) return direct;
        const commentApp = document.querySelector("#commentapp");
        if (commentApp) {
            const nested = commentApp.querySelector("bili-comments");
            if (nested) return nested;
        }
        return null;
    }

    // 优先从渲染节点和等级图标中推断评论用户等级。
    function extractLevelFromRenderer(commentRenderer) {
        const sr = getOpenShadow(commentRenderer);
        if (!sr) return null;
        const infoHost = q(sr, "bili-comment-user-info");
        if (infoHost) {
            const infoSr = getOpenShadow(infoHost);
            if (infoSr) {
                const levelImg =
                    q(infoSr, "#user-level img") ||
                    q(infoSr, ".level-icon") ||
                    q(infoSr, '[class*="level"] img');
                if (levelImg) {
                    const imgSrc = levelImg.getAttribute("src") || "";
                    let match = imgSrc.match(/level_(\w+)\.svg/i); // "level_6.svg" 匹配到 "6", "level_h.svg" 匹配到 "h"
                    if (match) {
                        if (match[1] === "h") {
                            // console.log('[清剿] 从图标识别为硬核会员 Lv6');
                            return 6;
                        } else {
                            const level = Number(match[1]);
                            if (Number.isFinite(level)) {
                                // console.log('[清剿] 从图标提取到等级 Lv' + level);
                                return level;
                            }
                        }
                    }
                }
                const levelEl =
                    q(infoSr, "#user-level") || q(infoSr, '[class*="level"]');
                if (levelEl) {
                    const levelText =
                        levelEl.getAttribute("alt") ||
                        levelEl.getAttribute("title") ||
                        levelEl.textContent;
                    if (levelText) {
                        const textMatch =
                            levelText.match(/lv(\d+)/i) ||
                            levelText.match(/level\s*(\d+)/i);
                        if (textMatch) return Number(textMatch[1]);
                    }
                }
            }
        }
        const allImgs = qa(sr, 'img[src*="level"], img[class*="level"]');
        for (const img of allImgs) {
            const imgSrc = img.getAttribute("src") || "";
            const match =
                imgSrc.match(/level_(\d+)\.(?:svg|png)/i) ||
                imgSrc.match(/lv(\d+)\.(?:svg|png)/i);
            if (match) return Number(match[1]);
        }
        return null;
    }

    // 从富文本评论宿主中提取最终显示给用户的评论文本。
    function extractTextFromRichTextHost(richHost) {
        if (!richHost) return "";
        const sr = getOpenShadow(richHost);
        const el = q(sr, "#contents") || q(sr, "p#contents") || richHost;
        return normalizeText(el?.innerText || el?.textContent || "");
    }

    // 统一把不同类型的评论节点解析为实际评论渲染节点。
    function resolveCommentRenderer(target) {
        if (!target) return null;
        const tag = getTagName(target);
        if (tag === "BILI-COMMENT-THREAD-RENDERER") {
            const sr = getOpenShadow(target);
            return q(sr, "#comment") || q(sr, "bili-comment-renderer");
        }
        if (
            tag === "BILI-COMMENT-REPLY-RENDERER" ||
            tag === "BILI-COMMENT-RENDERER"
        )
            return target;
        return null;
    }

    // 从评论节点中组装后续识别与操作所需的完整评论信息。
    function extractCommentDataFromTarget(target) {
        const renderer = resolveCommentRenderer(target);
        if (!renderer) return null;
        const sr = getOpenShadow(renderer);
        if (!sr) return null;

        // 直接从 DOM 获取用户信息（不再依赖 Vue 数据）
        const infoHost = q(sr, "bili-comment-user-info");
        const infoSr = getOpenShadow(infoHost);
        const nameLink =
            q(infoSr, "#user-name a") ||
            q(infoSr, "#user-name") ||
            q(sr, '#header a[href*="space.bilibili.com/"]');
        const avatarLink =
            q(sr, '#user-avatar[href*="space.bilibili.com/"]') ||
            q(sr, 'a[href*="space.bilibili.com/"]');
        const uidMatch = (nameLink?.href || avatarLink?.href || "").match(
            /space\.bilibili\.com\/(\d+)/,
        );
        const uid = uidMatch ? uidMatch[1] : null;
        if (!uid) return null;

        // 提取评论内容
        const richHost =
            q(sr, "#content bili-rich-text") ||
            q(sr, "#reply-content bili-rich-text") ||
            q(sr, "#body bili-rich-text") ||
            q(sr, "bili-rich-text");
        const text = extractTextFromRichTextHost(richHost);
        if (!text) return null;

        // 获取用户名
        const name = normalizeText(
            nameLink?.innerText || nameLink?.textContent || "未命名",
        );

        // 提取等级（完全依赖 DOM 图标解析，已包含硬核会员识别）
        const level = extractLevelFromRenderer(renderer);

        // 提取链接文本（用于标记学习）
        let linkText = "";
        try {
            const linkRenderer = resolveCommentRenderer(target);
            if (linkRenderer) {
                const linkSr = getOpenShadow(linkRenderer);
                if (linkSr) {
                    const allLinks = qa(
                        linkSr,
                        "#contents a, #reply-content a, bili-rich-text a",
                    );
                    if (allLinks.length > 0)
                        linkText = allLinks
                            .map((a) =>
                                normalizeText(
                                    a.innerText || a.textContent || "",
                                ),
                            )
                            .filter(Boolean)
                            .join(" ");
                }
            }
        } catch (e) {}

        return {
            uid,
            name,
            text,
            level,
            linkText,
            element: target,
            actionHost: renderer,
        };
    }

    // ========== WBI 签名相关 ==========
    let wbiKeys = { img_key: "", sub_key: "" };
    // 获取 B 站接口调用需要的 WBI 签名密钥。
    async function fetchWbiKeys() {
        if (wbiKeys.img_key && wbiKeys.sub_key) return wbiKeys;
        try {
            const res = await fetch(
                "https://api.bilibili.com/x/web-interface/nav",
                {
                    credentials: "include",
                    headers: {
                        "User-Agent": navigator.userAgent,
                        Referer: "https://www.bilibili.com/",
                    },
                },
            );
            const json = await res.json();
            const imgUrl = json?.data?.wbi_img?.img_url || "";
            const subUrl = json?.data?.wbi_img?.sub_url || "";
            wbiKeys.img_key = imgUrl.split("/").pop().split(".")[0];
            wbiKeys.sub_key = subUrl.split("/").pop().split(".")[0];
        } catch (e) {
            console.warn("[清剿] WBI 密钥获取失败", e);
        }
        return wbiKeys;
    }

    // 计算请求签名使用的 MD5 值，内部包含所需的位运算辅助函数。
    function md5(string) {
        function rotateLeft(lValue, iShiftBits) {
            return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
        }
        function addUnsigned(lX, lY) {
            let lX4, lY4, lX8, lY8, lResult;
            lX8 = lX & 0x80000000;
            lY8 = lY & 0x80000000;
            lX4 = lX & 0x40000000;
            lY4 = lY & 0x40000000;
            lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
            if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
            if (lX4 | lY4) {
                if (lResult & 0x40000000)
                    return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
                else return lResult ^ 0x40000000 ^ lX8 ^ lY8;
            } else return lResult ^ lX8 ^ lY8;
        }
        function F(x, y, z) {
            return (x & y) | (~x & z);
        }
        function G(x, y, z) {
            return (x & z) | (y & ~z);
        }
        function H(x, y, z) {
            return x ^ y ^ z;
        }
        function I(x, y, z) {
            return y ^ (x | ~z);
        }
        function FF(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function GG(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function HH(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function II(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function convertToWordArray(string) {
            let lMessageLength = string.length;
            let lNumberOfWords_temp1 = lMessageLength + 8;
            let lNumberOfWords_temp2 =
                (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
            let lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
            let lWordArray = Array(lNumberOfWords - 1);
            let lBytePosition = 0,
                lByteCount = 0;
            let lWordCount = 0; // 声明提到 while 外部，保证后面可访问
            while (lByteCount < lMessageLength) {
                lWordCount = (lByteCount - (lByteCount % 4)) / 4; // 修正点：声明变量并正确拼写为 lWordCount
                lBytePosition = (lByteCount % 4) * 8;
                lWordArray[lWordCount] =
                    lWordArray[lWordCount] |
                    (string.charCodeAt(lByteCount) << lBytePosition);
                lByteCount++;
            }
            lWordCount = (lByteCount - (lByteCount % 4)) / 4; // 此处 lWordCount 已在上一行声明，可复用
            lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] =
                lWordArray[lWordCount] | (0x80 << lBytePosition);
            lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
            lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
            return lWordArray;
        }
        function wordToHex(lValue) {
            let wordToHexValue = "",
                wordToHexValue_temp = "",
                lByte,
                lCount;
            for (lCount = 0; lCount <= 3; lCount++) {
                lByte = (lValue >>> (lCount * 8)) & 255;
                wordToHexValue_temp = "0" + lByte.toString(16);
                wordToHexValue =
                    wordToHexValue +
                    wordToHexValue_temp.substr(
                        wordToHexValue_temp.length - 2,
                        2,
                    );
            }
            return wordToHexValue;
        }
        function utf8_encode(string) {
            string = string.replace(/\r\n/g, "\n");
            let utftext = "";
            for (let n = 0; n < string.length; n++) {
                let c = string.charCodeAt(n);
                if (c < 128) utftext += String.fromCharCode(c);
                else if (c > 127 && c < 2048) {
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
        let S11 = 7,
            S12 = 12,
            S13 = 17,
            S14 = 22;
        let S21 = 5,
            S22 = 9,
            S23 = 14,
            S24 = 20;
        let S31 = 4,
            S32 = 11,
            S33 = 16,
            S34 = 23;
        let S41 = 6,
            S42 = 10,
            S43 = 15,
            S44 = 21;
        string = utf8_encode(string);
        x = convertToWordArray(string);
        a = 0x67452301;
        b = 0xefcdab89;
        c = 0x98badcfe;
        d = 0x10325476;
        for (k = 0; k < x.length; k += 16) {
            AA = a;
            BB = b;
            CC = c;
            DD = d;
            a = FF(a, b, c, d, x[k], S11, 0xd76aa478);
            d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
            c = FF(c, d, a, b, x[k + 2], S13, 0x242070db);
            b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
            a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf);
            d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
            c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613);
            b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
            a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8);
            d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
            c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1);
            b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
            a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122);
            d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
            c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e);
            b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
            a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562);
            d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
            c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51);
            b = GG(b, c, d, a, x[k], S24, 0xe9b6c7aa);
            a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d);
            d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
            c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681);
            b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
            a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6);
            d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
            c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87);
            b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
            a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905);
            d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
            c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9);
            b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
            a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942);
            d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
            c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122);
            b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
            a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44);
            d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
            c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60);
            b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
            a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6);
            d = HH(d, a, b, c, x[k], S32, 0xeaa127fa);
            c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085);
            b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
            a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039);
            d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
            c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8);
            b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
            a = II(a, b, c, d, x[k], S41, 0xf4292244);
            d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
            c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7);
            b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
            a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3);
            d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
            c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d);
            b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
            a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f);
            d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
            c = II(c, d, a, b, x[k + 6], S43, 0xa3014314);
            b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
            a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82);
            d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
            c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb);
            b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
            a = addUnsigned(a, AA);
            b = addUnsigned(b, BB);
            c = addUnsigned(c, CC);
            d = addUnsigned(d, DD);
        }
        return (
            wordToHex(a) +
            wordToHex(b) +
            wordToHex(c) +
            wordToHex(d)
        ).toLowerCase();
    }

    // 正确的 WBI 签名映射表
    const MIXIN_KEY_ENC_TAB = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
        49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24,
        55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
        57, 62, 11, 36, 20, 34, 44, 52,
    ];

    // 生成正确的 mixin_key
    function getMixinKey(orig) {
        let temp = "";
        MIXIN_KEY_ENC_TAB.forEach((n) => (temp += orig[n]));
        return temp.slice(0, 32);
    }

    // 修正后的 WBI 签名生成
    function generateWbi(sortedParams, wts) {
        const { img_key, sub_key } = wbiKeys;
        if (!img_key || !sub_key) return "";
        const mixinKey = getMixinKey(img_key + sub_key);
        const query = sortedParams.join("&") + "&wts=" + wts;
        return md5(query + mixinKey);
    }

    // ========== 请求队列（节流 + 修正头部） ==========
    const fetchQueue = [];
    let fetchTimer = null;
    const FETCH_DELAY = 2200; // 请求间隔，略高于官方限制，避免过快触发频率限制

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
                    credentials: "include",
                    headers: {
                        "User-Agent": navigator.userAgent,
                        Referer: "https://www.bilibili.com/",
                        Origin: "https://www.bilibili.com",
                        Accept: "application/json, text/plain, */*",
                        ...(task.options.headers || {}),
                    },
                    ...task.options,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (json.code !== 0) {
                    if (
                        json.code === -412 ||
                        json.code === -509 ||
                        json.code === -799
                    ) {
                        // 生成 2~5 秒的随机退避时间，防止压制
                        const backoff = 2000 + Math.floor(Math.random() * 3000);
                        console.log(
                            `[清剿] 频率限制(${json.code})，等待 ${(backoff / 1000).toFixed(1)} 秒后重试`,
                        );
                        fetchQueue.unshift(task);
                        setTimeout(() => processFetchQueue(), backoff);
                    } else {
                        throw new Error(json.message || "API error");
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
            requestJson(
                `https://api.bilibili.com/x/web-interface/card?mid=${uid}`,
            ),
        ]);

        // cardData 包含 fans, attention, archive_count (视频数), like_num (获赞数)
        const card = cardData?.card || {};
        const stat = cardData || {};

        return {
            sign: normalizeText(infoData.sign || ""),
            name: infoData.name,
            // 🆕 从新接口更新用户统计数据
            following: card?.attention || 0, // 关注数
            fans: card?.fans || 0, // 粉丝数
            videos: stat?.archive_count || 0, // 视频/专栏投稿总数 (替代播放数)
            likes: stat?.like_num || 0, // 获赞数
        };
    }

    // 获取用户置顶或最新动态，并附带动态类型概览。
    async function fetchLatestDynamic(uid) {
        try {
            const data = await requestJson(
                `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`,
            );
            const items = data.items || [];
            if (items.length === 0) return null;

            // 🆕 获取所有动态的类型信息
            const dynamicTypes = items.map((item) => item.type || "");

            // 取置顶或最新动态
            const topItem = items.find(
                (item) =>
                    item.top === 1 || item.modules?.module_tag?.text === "置顶",
            );
            const item = topItem || items[0];
            const desc = item.modules?.module_dynamic?.desc?.text || "";
            const dynamicId = item.id_str || item.basic?.comment_id_str || "";
            return {
                id: dynamicId,
                text: normalizeText(desc),
                // 🆕 新增：动态类型列表和动态总数
                types: dynamicTypes,
                totalCount: items.length,
            };
        } catch (e) {
            console.warn("[清剿] 获取动态失败", e);
            return null;
        }
    }

    // 抓取最新动态下的少量评论文本，用于二次广告检测。
    async function fetchDynamicComments(dynamicId) {
        try {
            const data = await requestJson(
                `https://api.bilibili.com/x/v2/reply?type=17&oid=${dynamicId}&pn=1&ps=3`,
            );
            const replies = data.replies || [];
            const texts = replies
                .map((r) => normalizeText(r.content?.message || ""))
                .filter(Boolean);
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
            params.set("mid", uid);
            params.set("ps", "1");
            params.set("tid", "0");
            params.set("pn", "1");
            params.set("keyword", "");
            params.set("order", "pubdate");
            params.set("wts", wts);
            const sortKeys = Array.from(params.keys()).sort();
            const sortedParams = sortKeys.map((k) => `${k}=${params.get(k)}`);
            const w_rid = generateWbi(sortedParams, wts);
            const url = `https://api.bilibili.com/x/space/wbi/arc/search?${sortedParams.join("&")}&w_rid=${w_rid}&wts=${wts}`;
            const data = await requestJson(url);
            const vlist = data.list?.vlist || [];
            if (vlist.length === 0) return null;
            return normalizeText(vlist[0].title || "");
        } catch (e) {
            console.warn("[清剿] 获取视频投稿失败", e);
            return null;
        }
    }

    // 判断文本里是否存在明显的引流词或联系方式信号。
    function hasAdKeywords(text) {
        if (!text) return false;
        const pattern =
            /(VX|wx|QQ|加群|扫码|进群|←戳|→戳|b23\.tv|https?:\/\/)/i;
        return pattern.test(text);
    }

    // 结合空间签名、动态、评论和投稿信息判断账号是否疑似广告号。
    async function checkUserProfile(uid) {
        const cached = profileCache.get(uid);
        if (cached && Date.now() - cached.time < CACHE_DURATION)
            return cached.result;
        if (pendingProfileChecks.has(uid)) return pendingProfileChecks.get(uid);

        const promise = (async () => {
            const details = {
                sign: null,
                dynamic: null,
                dynamicComments: [],
                video: null,
                empty: false,
            };
            let isAd = false;
            try {
                // 1. 获取空间基本信息（两个接口并行，但受队列控制，仍为两个请求）
                const space = await fetchSpaceInfo(uid);
                console.log(`[清剿] UID ${uid} 空间信息:`, space);

                // 检查低活跃画像（三无账号）
                const isLowActivity =
                    space.fans < 10 && space.likes < 10 && space.videos < 10;
                if (isLowActivity) {
                    isAd = true;
                    console.log("[清剿] 命中异常纯净画像识别规则（低活跃）");
                }

                details.sign = space.sign;
                console.log(`[清剿] UID ${uid} 签名:`, space.sign);
                if (hasAdKeywords(space.sign)) {
                    isAd = true;
                    console.log("[清剿] 签名命中引流词");
                }

                // ✅ 关键优化：如果已经判定为广告，直接返回，不再请求动态和视频
                if (isAd) {
                    const result = { isAd, details };
                    profileCache.set(uid, { result, time: Date.now() });
                    return result;
                }

                // 2. 获取最新动态（仅在空间信息未判定广告时执行）
                const dynamic = await fetchLatestDynamic(uid);
                const isAllForward =
                    dynamic &&
                    dynamic.totalCount <= 2 &&
                    dynamic.types.length > 0 &&
                    dynamic.types.every(
                        (type) => type === "DYNAMIC_TYPE_FORWARD",
                    );
                if (isAllForward) {
                    isAd = true;
                    console.log(
                        "[清剿] 命中异常纯净画像识别规则（纯转发动态）",
                    );
                }

                if (dynamic) {
                    details.dynamic = dynamic.text;
                    console.log(`[清剿] UID ${uid} 最新动态:`, dynamic.text);
                    if (!isAd && hasAdKeywords(dynamic.text)) {
                        isAd = true;
                        console.log("[清剿] 动态命中引流词");
                    }
                    if (!isAd) {
                        const comments = await fetchDynamicComments(dynamic.id);
                        details.dynamicComments = comments;
                        console.log(`[清剿] UID ${uid} 动态评论:`, comments);
                        if (comments.some((c) => hasAdKeywords(c))) {
                            isAd = true;
                            console.log("[清剿] 动态评论区命中引流词");
                        }
                    }
                }

                // ✅ 再次检查是否已判定为广告，若是则跳过视频请求
                if (isAd) {
                    const result = { isAd, details };
                    profileCache.set(uid, { result, time: Date.now() });
                    return result;
                }

                // 3. 获取最新视频标题（仅在之前未判定广告时执行）
                const videoTitle = await fetchLatestVideo(uid);
                if (videoTitle) {
                    details.video = videoTitle;
                    console.log(`[清剿] UID ${uid} 最新视频:`, videoTitle);
                    if (!isAd && hasAdKeywords(videoTitle)) {
                        isAd = true;
                        console.log("[清剿] 视频标题命中引流词");
                    }
                }

                // 4. 完全空空间判定
                if (!space.sign && !dynamic && !videoTitle) {
                    isAd = true;
                    details.empty = true;
                    console.log("[清剿] 空间为空，判定为广告号");
                }
            } catch (e) {
                console.warn(`[清剿] 空间检查失败 (UID ${uid})`, e);
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
        const actionButtonsHost = q(
            sr,
            "#footer bili-comment-action-buttons-renderer",
        );
        const actionButtonsSr = getOpenShadow(actionButtonsHost);
        const pubdate = q(actionButtonsSr, "#pubdate");
        if (pubdate?.parentElement) {
            pubdate.insertAdjacentElement("afterend", btn);
            return true;
        }
        const ops =
            q(actionButtonsSr, "#footer") ||
            q(actionButtonsSr, '[class*="action"]') ||
            q(sr, "#footer .ops") ||
            q(sr, ".reply-op") ||
            q(sr, '[class*="oper"]') ||
            q(sr, "#footer") ||
            q(sr, ".sub-op");
        if (ops && ops !== sr && ops !== actionButtonsSr) {
            ops.appendChild(btn);
            return true;
        }
        return false;
    }

    // 合并并持久化新增关键词，同时同步给当前检测器实例。
    async function updateUserKeywords(newWords) {
        if (!newWords || newWords.length === 0) return;
        const { userKeywords = [] } =
            await chrome.storage.local.get("userKeywords");
        const updated = [...new Set([...userKeywords, ...newWords])];
        await chrome.storage.local.set({ userKeywords: updated });
        if (
            window.AdDetector &&
            typeof window.AdDetector.setUserKeywords === "function"
        )
            window.AdDetector.setUserKeywords(updated);
    }

    // 在长文本评论场景下提示用户手动输入更精确的关键词。
    function promptForKeywords(item) {
        const baseHits = [];
        if (/戳这里|点这里|看我主页|私信|加微信|进群|资源/.test(item.text))
            baseHits.push("疑似引流词：戳这里/看我主页");
        const userInput = prompt(
            "⚠️ 该评论文本过长且无链接，为避免污染词库，\n请手动输入你想要拦截的核心关键词：\n（多个词请用空格隔开）",
            baseHits.join(" "),
        );
        if (!userInput) return null;
        return userInput
            .trim()
            .split(/\s+/)
            .filter((k) => k.length >= 2);
    }

    // 为评论添加“标记为广告”按钮，用于人工补充词库。
    function addMarkButton(item, el) {
        if (
            el.dataset.markBtnAdded === "true" ||
            el.dataset.adUserMarked === "true"
        )
            return;
        el.dataset.markBtnAdded = "true";
        const btn = document.createElement("span");
        btn.className = "bili-ad-learner-btn";
        btn.style.cssText =
            "display:inline-flex; align-items:center; justify-content:center; margin-left:4px; color:#fff; background:#6c757d; border-radius:4px; width:16px; height:16px; font-size:11px; line-height:1; cursor:pointer; user-select:none; z-index:999; opacity:0.8; padding:0;";
        btn.textContent = "📌";
        btn.title = "标记为广告，并将关键词加入永久词库";
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const learnBtn = e.currentTarget;
            learnBtn.textContent = "⏳";
            learnBtn.style.background = "#5a6268";
            learnBtn.style.pointerEvents = "none";
            let newWords = [];
            const hasLinkText =
                item.linkText && item.linkText.trim().length > 0;
            const sourceText = hasLinkText ? item.linkText : item.text;
            // 剥离 URL 后的纯文字长度：URL 不算“内容”，不应撑高字数触发弹窗
            const textWithoutUrls = (item.text || "")
                .replace(/https?:\/\/\S+/g, "")
                .trim();

            if (hasLinkText) {
                // linkText 是 DOM 提取的 <a> 链接文本，直接提取
                newWords = extractKeywords(sourceText);
            } else if (textWithoutUrls.length <= 120) {
                // 去掉 URL 后剩余文字不超过 120 字：直接从全文提取
                // extractKeywords 内部会自动剥离 URL，只对中文话术做关键词提取
                // “注册领1000RH币”、“免费生成”这类广告话术能被正确学习
                newWords = extractKeywords(item.text);
            } else {
                // 去掉 URL 后剩余文字仍超 120 字（确实是超长评论）：才弹窗让用户指定核心词
                newWords = promptForKeywords(item);
                if (!newWords) {
                    learnBtn.textContent = "📌";
                    learnBtn.style.background = "#6c757d";
                    learnBtn.style.pointerEvents = "auto";
                    return;
                }
            }
            if (newWords.length === 0)
                newWords = [sourceText.trim()].filter((t) => t.length > 0);
            if (newWords.length === 0) {
                alert("未能提取到关键词。");
                learnBtn.textContent = "📌";
                learnBtn.style.background = "#6c757d";
                learnBtn.style.pointerEvents = "auto";
                return;
            }
            // 判断贝叶斯是否已就绪
            const bayesReady =
                window.BayesClassifier && window.BayesClassifier.isReady();
            if (!bayesReady) {
                // 贝叶斯样本不足，仍然使用词库学习
                await updateUserKeywords(newWords);
            } else {
                console.log("[贝叶斯] 样本已充足，不再更新词库");
            }
            if (window.BayesClassifier) {
                const features = window.AdDetector.extractFeatures(sourceText);
                window.BayesClassifier.update(features, "ad");
                console.log("[贝叶斯] 学习正样本（广告）");
            }
            el.dataset.adUserMarked = "true";
            learnBtn.remove();
            const oldCleaner = el.querySelector(".bili-ad-cleaner-btn");
            if (oldCleaner) oldCleaner.remove();
            el.dataset.adCleanerProcessed = "false";
            tryAddButton(item);
            scanAndMarkAllComments();
        });
        const actionHost = item.actionHost || el;
        const sr = getOpenShadow(actionHost);
        if (sr) {
            const ops =
                q(sr, "#footer .ops") ||
                q(sr, ".reply-op") ||
                q(sr, '[class*="oper"]') ||
                q(sr, "#footer");
            if (ops) {
                ops.appendChild(btn);
                return;
            }
        }
        el.style.position = "relative";
        btn.style.position = "absolute";
        btn.style.right = "80px";
        btn.style.top = "50%";
        btn.style.transform = "translateY(-50%)";
        el.appendChild(btn);
    }

    // 为评论展示清剿按钮，并处理手动拉黑逻辑。
    function showCleanerButton(item, el, isHighLevel, rawLevel) {
        if (
            el.dataset.adCleanerProcessed === "true" &&
            el.querySelector(".bili-ad-cleaner-btn")
        )
            return;

        const btn = document.createElement("span");
        btn.className = "bili-ad-cleaner-btn";
        btn.style.cssText =
            "display:inline-flex; align-items:center; margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px; padding:2px 8px; font-size:12px; line-height:1.4; cursor:pointer; user-select:none; z-index:999; white-space:nowrap;";
        btn.textContent = "🚫 清剿";
        btn.title = isHighLevel
            ? "等级较高或等级未知，仅提示，不拉黑"
            : "直接拉黑";

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (isHighLevel) {
                const reason =
                    rawLevel === null || rawLevel === undefined
                        ? "该用户等级未知，可能为高等级账号或6级硬核会员。"
                        : `该用户等级为 Lv${rawLevel}，可能为被盗的高级号。`;
                alert(
                    `⚠️ ${reason}\n已跳过自动拉黑，请手动举报（右键评论 -> 举报）。`,
                );
                return;
            }

            if (
                autoCleanActive &&
                autoCleanQueue.some((q) => q.uid === item.uid)
            ) {
                alert("该账号已经在自动清剿队列中，无需手动操作。");
                return;
            }

            removeFromAutoCleanQueue(item.uid);

            try {
                const jctMatch = document.cookie.match(
                    /(?:^|;\s*)bili_jct=([^;]+)/,
                );
                const biliJct = jctMatch ? jctMatch[1] : "";
                if (!biliJct) {
                    alert("未登录 B站");
                    return;
                }
                const res = await fetch(
                    "https://api.bilibili.com/x/relation/modify",
                    {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type":
                                "application/x-www-form-urlencoded; charset=UTF-8",
                            Origin: "https://www.bilibili.com",
                            Referer: "https://www.bilibili.com/",
                        },
                        body: new URLSearchParams({
                            fid: item.uid,
                            act: "5",
                            re_src: 11,
                            csrf: biliJct,
                        }),
                    },
                );
                const json = await res.json();
                if (json.code !== 0) throw new Error(json.message);
                el.dataset.adBlocked = "true";
                btn.textContent = "✅ 已清剿";
                btn.style.background = "#999";
                btn.style.pointerEvents = "none";
            } catch (err) {
                alert("拉黑失败：" + err.message);
            }
        });

        if (mountButtonToComment(item, btn)) {
            el.dataset.adCleanerProcessed = "true";
            item.cleanerBtn = btn;
        } else {
            el.style.position = "relative";
            btn.style.position = "absolute";
            btn.style.right = "8px";
            btn.style.top = "50%";
            btn.style.transform = "translateY(-50%)";
            el.appendChild(btn);
            el.dataset.adCleanerProcessed = "true";
            item.cleanerBtn = btn;
        }
    }

    // 将疑似广告账号加入自动清剿队列，避免重复入队。
    function enqueueAutoClean(item) {
        if (autoCleanQueue.some((queued) => queued.uid === item.uid)) return;
        if (item.element?.dataset?.adBlocked === "true") return;
        autoCleanQueue.push(item);
        updateAutoCleanPanel();
        console.log("[清剿] 自动入队:", item.name, "(Lv" + item.level + ")");
    }

    // 从自动清剿队列中移除指定用户。
    function removeFromAutoCleanQueue(uid) {
        const index = autoCleanQueue.findIndex((q) => q.uid === uid);
        if (index !== -1) {
            autoCleanQueue.splice(index, 1);
            updateAutoCleanPanel();
        }
    }

    // 评估评论风险，并决定是否展示按钮或触发空间复核。
    // 从页面获取当前视频的 UP 主 UID，结果会被缓存
    // 策略： __INITIAL_STATE__ → 页面 DOM 链接 → 放弃（本地取，不接口请求）
    let _videoOwnerUid = undefined; // undefined = 未尝试, null = 取不到, string = 有效 UID
    function getVideoOwnerUid() {
        if (_videoOwnerUid !== undefined) return _videoOwnerUid;

        // 方法 1：__INITIAL_STATE__（视频页 window.__INITIAL_STATE__.videoData.owner.mid）
        try {
            const state = window.__INITIAL_STATE__;
            const mid =
                state?.videoData?.owner?.mid ||
                state?.upData?.mid ||
                state?.mediaInfo?.up_info?.mid;
            if (mid) {
                _videoOwnerUid = String(mid);
                return _videoOwnerUid;
            }
        } catch {}

        // 方法 2：从视频作者主页链接提取（/space/<uid>）
        try {
            const authorLink =
                document.querySelector(
                    '.up-info-container a[href*="/space/"]',
                ) ||
                document.querySelector('.video-author-name[href*="/space/"]') ||
                document.querySelector('a.username[href*="/space/"]') ||
                document.querySelector(
                    '[class*="up"] a[href*="space.bilibili.com"]',
                );
            if (authorLink) {
                const match = authorLink.href.match(
                    /(?:space\.bilibili\.com|bilibili\.com\/space)\/?(\d+)/,
                );
                if (match) {
                    _videoOwnerUid = match[1];
                    return _videoOwnerUid;
                }
            }
        } catch {}

        // 两种方法均失败（如直播间/番剧页等非标准视频页）：不阻塞，返回 null
        _videoOwnerUid = null;
        return null;
    }

    // 新增函数：添加负样本
    async function addNegativeSample(item) {
        if (!window.BayesClassifier) return;
        // 避免重复学习（用元素数据集标记）
        if (item.element && item.element.dataset.bayesNegative === "true")
            return;
        if (item.element) item.element.dataset.bayesNegative = "true";

        const features = window.AdDetector.extractFeatures(item.text);
        window.BayesClassifier.update(features, "normal");
        console.log("[贝叶斯] 学习负样本（正常）");
    }

    async function tryAddButton(item) {
        const el = item.element;
        if (!el) return;
        if (
            !window.AdDetector ||
            typeof window.AdDetector.analyze !== "function"
        )
            return;

        const alreadyHasCleaner = el.dataset.adCleanerProcessed === "true";
        const isUserMarked = el.dataset.adUserMarked === "true";
        const alreadyBlocked = el.dataset.adBlocked === "true";

        if (alreadyHasCleaner || alreadyBlocked) {
            const alreadyHasMark = el.dataset.markBtnAdded === "true";
            if (!alreadyHasMark && !isUserMarked) addMarkButton(item, el);
            return;
        }
        // console.log('[清剿] 评估评论:', item.text, '(UID ' + item.uid + ', Lv' + item.level + ')');
        // 提取特征（用于贝叶斯）
        let features = null;
        if (window.BayesClassifier && window.BayesClassifier.isReady()) {
            features = window.AdDetector.extractFeatures(item.text);
        }
        let score = 0;
        if (isUserMarked) score = 100;
        else
            score = await window.AdDetector.analyze({
                content: item.text,
                level: item.level,
                avatarUrl: "",
                features: features,
            });

        const rawLevel = item.level;
        const isHighLevel =
            rawLevel === null || rawLevel === undefined || rawLevel >= 4;
        const hasStrongSignal = window.AdDetector.hasStrongAdSignals
            ? window.AdDetector.hasStrongAdSignals(item.text)
            : false;

        // UP 主在自己视频下发带链接的置顶评论是正常行为，不能被 hasStrongSignal 直接拦截
        // 取视频 UP 主 UID：优先读 __INITIAL_STATE__，免去 API 请求
        const videoOwnerUid = getVideoOwnerUid();
        const isVideoOwner =
            videoOwnerUid !== null &&
            String(item.uid) === String(videoOwnerUid);

        // 三种情况需要二次确认（空间检测）：
        //   1. 命中 hasStrongSignal 且是视频 UP 主（置顶带链接是正常行为）
        //   2. 未命中 hasStrongSignal 且分数 >= 40（原有逻辑）
        //   3. 用户手动标记且是 UP 主（额外保险）
        const needProfileCheck =
            (hasStrongSignal && isVideoOwner) ||
            (!hasStrongSignal && !isUserMarked && score >= 40) ||
            (isUserMarked && isVideoOwner);

        if (score >= 40 || isUserMarked) {
            // 命中强信号且不是 UP 主，或者用户手动标记且不是 UP 主：直接标记
            if (
                (hasStrongSignal && !isVideoOwner) ||
                (isUserMarked && !isVideoOwner)
            ) {
                showCleanerButton(item, el, isHighLevel, rawLevel);
                if (!isHighLevel && !alreadyBlocked) enqueueAutoClean(item);
            } else if (needProfileCheck) {
                if (el.dataset.adProfilePending === "true") return;
                el.dataset.adProfilePending = "true";

                const placeholder = document.createElement("span");
                placeholder.className = "bili-ad-cleaner-placeholder";
                placeholder.style.cssText =
                    "display:inline-flex; align-items:center; margin-left:12px; color:#bfc7d5; background:rgba(255,255,255,0.06); border-radius:4px; padding:2px 8px; font-size:12px; white-space:nowrap;";
                placeholder.textContent = "⏳ 检测中";
                mountButtonToComment(item, placeholder) ||
                    el.appendChild(placeholder);

                checkUserProfile(item.uid)
                    .then(({ isAd, error }) => {
                        console.log(
                            `[清剿] 空间检测结果 (UID ${item.uid}):`,
                            isAd ? "疑似广告" : "正常账号",
                            error ? `(错误: ${error})` : "",
                        );
                        if (placeholder) placeholder.remove();
                        delete el.dataset.adProfilePending;

                        if (error) {
                            console.warn(
                                "[清剿] 空间检测失败，回退显示清剿按钮",
                                error,
                            );
                            // 回退：按原规则显示按钮
                            showCleanerButton(item, el, isHighLevel, rawLevel);
                            if (!isHighLevel && !el.dataset.adBlocked)
                                enqueueAutoClean(item);
                        } else if (isAd) {
                            console.log("[清剿] 空间检测确认广告，显示按钮");
                            showCleanerButton(item, el, isHighLevel, rawLevel);
                            if (!isHighLevel && !el.dataset.adBlocked)
                                enqueueAutoClean(item);
                        } else {
                            console.log("[清剿] 空间正常，取消广告标记");
                            // 🔧 关键修复：标记为已处理，防止重复扫描
                            el.dataset.adCleanerProcessed = "true";
                            // 延迟5秒后学习为负样本（避免用户随后又标记）
                            setTimeout(() => {
                                if (el && !el.dataset.adUserMarked) {
                                    // 确保未被手动标记为广告
                                    addNegativeSample(item);
                                }
                            }, 5000);
                        }
                    })
                    .catch((err) => {
                        if (placeholder) placeholder.remove();
                        delete el.dataset.adProfilePending;
                        console.error("[清剿] 空间检测异常，回退显示按钮", err);
                        showCleanerButton(item, el, isHighLevel, rawLevel);
                        if (!isHighLevel && !el.dataset.adBlocked)
                            enqueueAutoClean(item);
                    });
            }
        }

        const alreadyHasMark = el.dataset.markBtnAdded === "true";
        if (!alreadyHasMark && !isUserMarked) {
            addMarkButton(item, el);
        }
    }

    // ========== 面板与自动 ==========
    // 构建右侧自动清剿面板，并缓存关键节点引用。
    function buildAutoCleanPanel() {
        if (autoCleanPanel) return autoCleanPanel;
        const panel = document.createElement("div");
        panel.id = "ad-clean-auto-panel";
        panel.style.cssText =
            "position:fixed; right:16px; top:96px; width:300px; max-height:50vh; z-index:999999; background:rgba(18,18,24,0.95); color:#f5f7fa; border:1px solid rgba(255,255,255,0.1); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.4); overflow:hidden; font-size:13px; display:none;";
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
        autoCleanListEl = panel.querySelector("#ad-clean-queue-list");
        autoCleanCurrentEl = panel.querySelector("#ad-clean-current");
        return panel;
    }

    // 刷新自动清剿面板的队列数量、当前项和显隐状态。
    function updateAutoCleanPanel() {
        if (!autoCleanPanel) return;
        const countEl = autoCleanPanel.querySelector("#ad-clean-queue-count");
        if (countEl) countEl.textContent = autoCleanQueue.length;
        if (autoCleanListEl) {
            autoCleanListEl.innerHTML = autoCleanQueue
                .map((item, idx) => {
                    const isCurrent = idx === 0;
                    return `<div style="padding:6px 10px; background:${isCurrent ? "rgba(251,114,153,0.15)" : "transparent"}; display:flex; justify-content:space-between; align-items:center; font-size:12px;">
          <span style="color:${isCurrent ? "#fb7299" : "#d6dbe3"};">${item.name} (Lv${item.level})</span>
          <span style="color:#888;">${item.text.slice(0, 20)}…</span>
        </div>`;
                })
                .join("");
        }
        if (autoCleanCurrentEl) {
            const current = autoCleanQueue[0];
            autoCleanCurrentEl.textContent = current
                ? `当前：${current.name} (Lv${current.level ?? "?"})`
                : "队列已空，等待新评论...";
        }
        autoCleanPanel.style.display = autoCleanActive ? "block" : "none";
    }

    // 依次处理自动清剿队列中的账号拉黑请求。
    async function processAutoCleanQueue() {
        if (!autoCleanActive || autoCleanQueue.length === 0) {
            updateAutoCleanPanel();
            return;
        }
        const item = autoCleanQueue[0];
        updateAutoCleanPanel();
        try {
            const jctMatch = document.cookie.match(
                /(?:^|;\s*)bili_jct=([^;]+)/,
            );
            const biliJct = jctMatch ? jctMatch[1] : "";
            if (!biliJct) throw new Error("未登录");
            const res = await fetch(
                "https://api.bilibili.com/x/relation/modify",
                {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "Content-Type":
                            "application/x-www-form-urlencoded; charset=UTF-8",
                        Origin: "https://www.bilibili.com",
                        Referer: "https://www.bilibili.com/",
                    },
                    body: new URLSearchParams({
                        fid: item.uid,
                        act: "5",
                        re_src: 11,
                        csrf: biliJct,
                    }),
                },
            );
            const json = await res.json();
            if (json.code !== 0) throw new Error(json.message);
            if (item.cleanerBtn) {
                item.cleanerBtn.textContent = "✅ 已清剿";
                item.cleanerBtn.style.background = "#999";
                item.cleanerBtn.style.pointerEvents = "none";
            } else if (item.element) {
                const actionHost = item.actionHost || item.element;
                const sr = getOpenShadow(actionHost);
                if (sr) {
                    const cleaner = sr.querySelector(".bili-ad-cleaner-btn");
                    if (cleaner) {
                        cleaner.textContent = "✅ 已清剿";
                        cleaner.style.background = "#999";
                        cleaner.style.pointerEvents = "none";
                    }
                }
            }
            if (item.element) item.element.dataset.adBlocked = "true";
            console.log("[清剿] 自动清剿成功:", item.name);
            autoCleanQueue.shift();
            updateAutoCleanPanel();
        } catch (err) {
            console.error("[清剿] 自动清剿失败:", item.uid, err);
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
        console.log("[清剿] 自动清剿已启动");
    }

    // 停止自动清剿，但保留当前待处理队列。
    function stopAutoClean() {
        autoCleanActive = false;
        if (autoCleanTimer) {
            clearInterval(autoCleanTimer);
            autoCleanTimer = null;
        }
        if (autoCleanPanel) autoCleanPanel.style.display = "none";
        console.log("[清剿] 自动清剿已停止（队列保留）");
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "startAutoClean") {
            startAutoClean();
            sendResponse({ ok: true });
        } else if (request.action === "stopAutoClean") {
            stopAutoClean();
            sendResponse({ ok: true });
        } else if (request.action === "getAutoCleanStatus") {
            sendResponse({ active: autoCleanActive });
        } else if (request.action === "updateKeywords") {
            initUserKeywords();
            sendResponse({ ok: true });
        } else if (request.action === "resetBayes") {
            (async () => {
                if (window.BayesClassifier) {
                    await window.BayesClassifier.reset();
                    console.log("[贝叶斯] 模型已重置");
                    sendResponse({ ok: true });
                } else {
                    sendResponse({
                        ok: false,
                        error: "BayesClassifier 未初始化",
                    });
                }
            })();
            return true; // 异步响应
        }
    });

    // 递归收集评论区域内所有需要监听的 Shadow Root。
    function collectCommentShadowRoots(
        root,
        visited = new WeakSet(),
        acc = [],
    ) {
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
            const targets = [
                ...qa(root, "bili-comment-thread-renderer"),
                ...qa(root, "bili-comment-reply-renderer"),
            ];
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
        scanTimer = window.setTimeout(() => {
            scanTimer = null;
            scanAndMarkAllComments();
        }, 50);
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
        const { userKeywords = [] } =
            await chrome.storage.local.get("userKeywords");
        if (
            window.AdDetector &&
            typeof window.AdDetector.setUserKeywords === "function"
        )
            window.AdDetector.setUserKeywords(userKeywords);
    }

    // 初始化贝叶斯分类器
    async function initBayesClassifier() {
        window.BayesClassifier = await IncrementalNaiveBayes.load();
        console.log(
            "[贝叶斯] 分类器已加载，样本数:",
            window.BayesClassifier.totalDocs,
        );
    }

    // 从评论宿主开始建立 Shadow DOM 监听链路。
    function startObservingShadow() {
        const host = getCommentsHost();
        if (!host) return;
        const sr = getOpenShadow(host);
        if (!sr) {
            setTimeout(startObservingShadow, 1000);
            return;
        }
        observeShadowRootRecursively(sr);
    }

    // 当贝叶斯样本数达到最小采样值时，自动清空用户词库（不再依赖关键词）
    async function maybeClearUserKeywords() {
        if (window.BayesClassifier && window.BayesClassifier.isReady()) {
            const { userKeywords } =
                await chrome.storage.local.get("userKeywords");
            if (userKeywords && userKeywords.length > 0) {
                await chrome.storage.local.set({ userKeywords: [] });
                if (
                    window.AdDetector &&
                    typeof window.AdDetector.setUserKeywords === "function"
                ) {
                    window.AdDetector.setUserKeywords([]);
                }
                console.log(
                    "[贝叶斯] 样本数已达最小采样值，已自动清空用户词库（后续不再依赖关键词）",
                );
            }
        }
    }

    // 等待评论区挂载完成后，初始化词库并启动评论监听。
    async function waitForHost() {
        await initUserKeywords();
        await initBayesClassifier();
        await maybeClearUserKeywords(); // 新增：贝叶斯样本充足时清空词库
        if (getCommentsHost()) {
            startObservingShadow();
            return;
        }
        const bodyObserver = new MutationObserver(() => {
            if (getCommentsHost()) {
                bodyObserver.disconnect();
                startObservingShadow();
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (
        document.readyState === "complete" ||
        document.readyState === "interactive"
    ) {
        waitForHost();
    } else {
        window.addEventListener("load", waitForHost);
    }
})();
