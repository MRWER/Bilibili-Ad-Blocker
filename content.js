// content.js – 终极增强版：穿透所有 Shadow DOM + 深度监听子评论
(function () {
  'use strict';
  console.log('[清剿] content.js 已注入 (增强监听版)');

  // ========== 工具函数 ==========
  function getOpenShadow(el) {
    try { return el && el.shadowRoot ? el.shadowRoot : null; } catch { return null; }
  }
  function q(root, sel) { return root && root.querySelector ? root.querySelector(sel) : null; }
  function qa(root, sel) { return root && root.querySelectorAll ? [...root.querySelectorAll(sel)] : []; }
  function normalizeText(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

  // ========== 评论区定位 ==========
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

  // 从 shadow root 获取所有 thread 渲染器
  function getThreadHostsFromRoot(root) {
    if (!root) return [];
    return qa(root, 'bili-comment-thread-renderer');
  }

  // 提取评论数据 (保持不变)
  function extractLevelFromRenderer(commentRenderer) {
    const sr = getOpenShadow(commentRenderer);
    if (!sr) return null;
    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const img = q(infoSr, '#user-level img') || q(sr, '#user-level img');
    const src = img?.getAttribute('src') || '';
    const m = src.match(/level_(\d+)\.svg/i);
    return m ? Number(m[1]) : null;
  }

  function extractTextFromRichTextHost(richHost) {
    if (!richHost) return '';
    const sr = getOpenShadow(richHost);
    const el = q(sr, '#contents') || q(sr, 'p#contents') || richHost;
    return normalizeText(el?.innerText || el?.textContent || '');
  }

  function extractCommentDataFromRenderer(commentRenderer) {
    const sr = getOpenShadow(commentRenderer);
    if (!sr) return null;
    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const nameLink = q(infoSr, '#user-name a') || q(sr, '#header a[href*="space.bilibili.com/"]');
    const avatarLink = q(sr, '#user-avatar[href*="space.bilibili.com/"]');
    const link = nameLink || avatarLink;
    const uidMatch = (link?.href || '').match(/space\.bilibili\.com\/(\d+)/);
    const uid = uidMatch ? uidMatch[1] : null;
    if (!uid) return null;

    const level = extractLevelFromRenderer(commentRenderer);
    const richHost = q(sr, '#content bili-rich-text') || getOpenShadow(commentRenderer).querySelector('bili-rich-text');
    const text = extractTextFromRichTextHost(richHost);
    if (!text) return null;

    return { uid, name: normalizeText(nameLink?.innerText || '未命名'), text, level, element: commentRenderer };
  }

  // 获取指定根节点下的所有评论（含子评论）
  function getAllCommentItemsFromRoot(root) {
    const items = [];
    // 查找一级和二级评论渲染器
    const renderers = qa(root, 'bili-comment-renderer#comment');
    const subReplyRenderers = qa(root, 'bili-comment-reply-renderer');
    const allRenderers = [...renderers, ...subReplyRenderers];
    
    for (const renderer of allRenderers) {
      const data = extractCommentDataFromRenderer(renderer);
      if (data) items.push(data);
    }
    return items;
  }

  // ========== 按钮添加 (保持不变) ==========
  function tryAddButton(item) {
    const el = item.element;
    if (!el || el.dataset.adCleanerProcessed === 'true') return;

    const score = window.AdDetector.analyze({
      content: item.text,
      level: item.level,
      avatarUrl: ''
    });
    console.log('[清剿] 评分', score, item.text.slice(0, 40));

    if (score >= 40) {
      const btn = document.createElement('span');
      btn.className = 'bili-ad-cleaner-btn';
      btn.style.cssText = 'margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px; padding:2px 8px; font-size:12px; cursor:pointer; user-select:none; z-index:999;';
      btn.textContent = '🚫 清剿';
      btn.title = '举报并拉黑该用户';

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`确定举报并拉黑？\n${item.text.slice(0,60)}…`)) return;
        try {
          const jctMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
          const biliJct = jctMatch ? jctMatch[1] : '';
          if (!biliJct) { alert('未登录 B站'); return; }
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
          btn.disabled = true;
        } catch (err) { alert('失败：' + err.message); }
      });

      const sr = getOpenShadow(el);
      if (sr) {
        const ops = q(sr, '#footer .ops') || q(sr, '.reply-op') || q(sr, '[class*="oper"]') || q(sr, '#footer') || q(sr, '.sub-op');
        if (ops && ops !== sr) {
          ops.appendChild(btn);
          el.dataset.adCleanerProcessed = 'true';
          return;
        }
      }
      el.style.position = 'relative';
      btn.style.position = 'absolute';
      btn.style.right = '8px';
      btn.style.top = '50%';
      btn.style.transform = 'translateY(-50%)';
      el.appendChild(btn);
      el.dataset.adCleanerProcessed = 'true';
    }
  }

  function scanAndMarkInRoot(root) {
    const items = getAllCommentItemsFromRoot(root);
    if (items.length > 0) {
        console.log('[清剿] 发现新评论，数量:', items.length);
        items.forEach(tryAddButton);
    }
  }

  // ========== 核心：递归监听所有 Shadow Root ==========
  const observedShadowRoots = new WeakSet();

  function observeShadowRootRecursively(root) {
    if (!root || observedShadowRoots.has(root)) return;
    observedShadowRoots.add(root);
    
    // 扫描当前根节点下的所有评论
    scanAndMarkInRoot(root);
    
    // 监听当前 shadow root 的变化
    const observer = new MutationObserver(() => {
      scanAndMarkInRoot(root);
    });
    observer.observe(root, { childList: true, subtree: true });
    console.log('[清剿] 已开始监听 Shadow Root');

    // 🆕 核心：查找所有下级评论容器 (thread 或 reply)，并递归观察它们的 shadowRoot
    const containers = qa(root, 'bili-comment-thread-renderer, bili-comment-reply-renderer');
    for (const container of containers) {
      const sr = getOpenShadow(container);
      if (sr) {
        observeShadowRootRecursively(sr); // 递归监听
      }
    }

    // 监听当前 root 下新增的容器，以便未来递归监听它们
    const containerObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 && (node.tagName === 'BILI-COMMENT-THREAD-RENDERER' || node.tagName === 'BILI-COMMENT-REPLY-RENDERER')) {
            const sr = getOpenShadow(node);
            if (sr && !observedShadowRoots.has(sr)) {
              console.log('[清剿] 发现新评论容器，递归监听其 Shadow Root');
              observeShadowRootRecursively(sr);
            }
          }
        }
      }
    });
    containerObserver.observe(root, { childList: true, subtree: true });
  }

  // ========== 启动监听 ==========
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

  // 全局监听 body，等待评论区宿主出现
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