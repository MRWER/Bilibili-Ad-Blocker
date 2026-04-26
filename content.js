// content.js – 终极增强版：穿透所有 Shadow DOM + 深度监听子评论
(function () {
  'use strict';
  console.log('[清剿] content.js 已注入 (增强监听版)');

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

  function getOpenShadow(el) {
    try { return el && el.shadowRoot ? el.shadowRoot : null; } catch { return null; }
  }

  function q(root, sel) {
    return root && root.querySelector ? root.querySelector(sel) : null;
  }

  function qa(root, sel) {
    return root && root.querySelectorAll ? [...root.querySelectorAll(sel)] : [];
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function getTagName(el) {
    return el?.tagName ? String(el.tagName).toUpperCase() : '';
  }

  function getCommentData(el) {
    return el && typeof el === 'object' ? el.__data || null : null;
  }

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

  function extractLevelFromData(commentData) {
    const rawLevel =
      commentData?.member?.level_info?.current_level ??
      commentData?.member?.level_info?.currentLevel ??
      commentData?.reply_control?.user_level ??
      null;
    const level = Number(rawLevel);
    return Number.isFinite(level) ? level : null;
  }

  function extractLevelFromRenderer(commentRenderer) {
    const dataLevel = extractLevelFromData(getCommentData(commentRenderer));
    if (dataLevel != null) return dataLevel;

    const sr = getOpenShadow(commentRenderer);
    if (!sr) return null;

    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const img = q(infoSr, '#user-level img') || q(sr, '#user-level img');
    const src = img?.getAttribute('src') || '';
    const match = src.match(/level_(\d+)\.svg/i);
    return match ? Number(match[1]) : null;
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

    if (tag === 'BILI-COMMENT-REPLY-RENDERER' || tag === 'BILI-COMMENT-RENDERER') {
      return target;
    }

    return null;
  }

  function extractCommentDataFromTarget(target) {
    const renderer = resolveCommentRenderer(target);
    const sr = getOpenShadow(renderer);
    if (!renderer || !sr) return null;

    const dataSource = getCommentData(target) || getCommentData(renderer);
    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const nameLink =
      q(infoSr, '#user-name a') ||
      q(infoSr, '#user-name') ||
      q(sr, '#header a[href*="space.bilibili.com/"]');
    const avatarLink =
      q(sr, '#user-avatar[href*="space.bilibili.com/"]') ||
      q(sr, 'a[href*="space.bilibili.com/"]');
    const uidFromData = dataSource?.mid || dataSource?.member?.mid || null;
    const uidFromLinkMatch = (nameLink?.href || avatarLink?.href || '').match(/space\.bilibili\.com\/(\d+)/);
    const uid = uidFromData ? String(uidFromData) : (uidFromLinkMatch ? uidFromLinkMatch[1] : null);
    if (!uid) return null;

    const richHost =
      q(sr, '#content bili-rich-text') ||
      q(sr, '#reply-content bili-rich-text') ||
      q(sr, '#body bili-rich-text') ||
      q(sr, 'bili-rich-text');
    const textFromData = normalizeText(dataSource?.content?.message || dataSource?.content?.text || '');
    const text = textFromData || extractTextFromRichTextHost(richHost);
    if (!text) return null;

    const name = normalizeText(dataSource?.member?.uname || nameLink?.innerText || nameLink?.textContent || '未命名');
    const level = extractLevelFromData(dataSource) ?? extractLevelFromRenderer(renderer);

    return {
      uid,
      name,
      text,
      level,
      element: target,
      actionHost: renderer
    };
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
      const targets = [
        ...qa(root, 'bili-comment-thread-renderer'),
        ...qa(root, 'bili-comment-reply-renderer')
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

  function mountButtonToComment(item, btn) {
    const actionHost = item.actionHost || item.element;
    const sr = getOpenShadow(actionHost);
    if (!sr) return false;

    const actionButtonsHost = q(sr, '#footer bili-comment-action-buttons-renderer');
    const actionButtonsSr = getOpenShadow(actionButtonsHost);
    const pubdate = q(actionButtonsSr, '#pubdate');

    if (pubdate?.parentElement) {
      pubdate.insertAdjacentElement('afterend', btn);
      return true;
    }

    const ops =
      q(actionButtonsSr, '#footer') ||
      q(actionButtonsSr, '[class*="action"]') ||
      q(sr, '#footer .ops') ||
      q(sr, '.reply-op') ||
      q(sr, '[class*="oper"]') ||
      q(sr, '#footer') ||
      q(sr, '.sub-op');

    if (ops && ops !== sr && ops !== actionButtonsSr) {
      ops.appendChild(btn);
      return true;
    }

    return false;
  }

  function tryAddButton(item) {
    const el = item.element;
    if (!el || el.dataset.adCleanerProcessed === 'true') return;
    if (!window.AdDetector || typeof window.AdDetector.analyze !== 'function') return;

    const score = window.AdDetector.analyze({
      content: item.text,
      level: item.level,
      avatarUrl: ''
    });
    console.log('[清剿] 评分', score, item.text.slice(0, 40));

    if (score < 40) return;

    const btn = document.createElement('span');
    btn.className = 'bili-ad-cleaner-btn';
    btn.style.cssText = 'display:inline-flex; align-items:center; margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px; padding:2px 8px; font-size:12px; line-height:1.4; cursor:pointer; user-select:none; z-index:999; white-space:nowrap;';
    btn.textContent = '🚫 清剿';
    btn.title = '举报并拉黑该用户';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定举报并拉黑？\n${item.text.slice(0, 60)}…`)) return;

      try {
        const jctMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
        const biliJct = jctMatch ? jctMatch[1] : '';
        if (!biliJct) {
          alert('未登录 B站');
          return;
        }

        const res = await fetch('https://api.bilibili.com/x/relation/modify', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://www.bilibili.com',
            'Referer': 'https://www.bilibili.com/'
          },
          body: new URLSearchParams({ fid: item.uid, act: '5', re_src: 11, csrf: biliJct })
        });
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.message);

        btn.textContent = '✅ 已清剿';
        btn.style.background = '#999';
        btn.style.pointerEvents = 'none';
      } catch (err) {
        alert('失败：' + err.message);
      }
    });

    if (mountButtonToComment(item, btn)) {
      el.dataset.adCleanerProcessed = 'true';
      return;
    }

    el.style.position = 'relative';
    btn.style.position = 'absolute';
    btn.style.right = '8px';
    btn.style.top = '50%';
    btn.style.transform = 'translateY(-50%)';
    el.appendChild(btn);
    el.dataset.adCleanerProcessed = 'true';
  }

  function scanAndMarkAllComments() {
    const items = getAllCommentItems();
    if (items.length > 0) {
      console.log('[清剿] 发现评论，数量:', items.length);
      items.forEach(tryAddButton);
    }
  }

  function scheduleFullScan() {
    if (scanTimer !== null) return;

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanAndMarkAllComments();
    }, 50);
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

    console.log('[清剿] 已开始监听 Shadow Root');
  }

  function startObservingShadow() {
    const host = getCommentsHost();
    if (!host) return;

    const sr = getOpenShadow(host);
    if (!sr) {
      console.warn('[清剿] 评论区宿主存在但 shadowRoot 为空，稍后重试');
      setTimeout(startObservingShadow, 1000);
      return;
    }

    console.log('[清剿] 开始递归监听评论区所有层级');
    observeShadowRootRecursively(sr);
  }

  function waitForHost() {
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
    console.log('[清剿] 等待评论区宿主出现...');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    waitForHost();
  } else {
    window.addEventListener('load', waitForHost);
  }
})();
