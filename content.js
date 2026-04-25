// content.js – 适配 B 站新版 Shadow DOM 评论区
(function () {
  'use strict';

  // ========== 工具函数 ==========
  function getOpenShadow(el) {
    try { return el && el.shadowRoot ? el.shadowRoot : null; } catch { return null; }
  }
  function q(root, sel) {
    return root && root.querySelector ? root.querySelector(sel) : null;
  }
  function qa(root, sel) {
    return root && root.querySelectorAll ? [...root.querySelectorAll(sel)] : [];
  }
  function deepQueryAll(root, selector, limit = 100) {
    const out = [];
    const seen = new Set();
    const stack = [root].filter(Boolean);
    while (stack.length && out.length < limit) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      if (cur.querySelectorAll) {
        for (const el of cur.querySelectorAll(selector)) out.push(el);
        for (const el of cur.querySelectorAll('*')) {
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      }
      if (cur.shadowRoot) stack.push(cur.shadowRoot);
    }
    return out;
  }
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // ========== 评论区定位与数据提取 ==========
  function getCommentsHost() {
    // 新版 B 站评论区宿主
    const direct = document.querySelector('bili-comments');
    if (direct) return direct;
    const commentApp = document.querySelector('#commentapp');
    if (commentApp) {
      const nested = commentApp.querySelector('bili-comments');
      if (nested) return nested;
    }
    return null;
  }

  function getThreadHosts() {
    const host = getCommentsHost();
    if (!host) return [];
    const sr = getOpenShadow(host);
    if (!sr) return [];
    const feed = q(sr, '#contents #feed') || q(sr, '#feed') || sr;
    return qa(feed, 'bili-comment-thread-renderer');
  }

  function extractLevelFromRenderer(commentRenderer) {
    const sr = getOpenShadow(commentRenderer);
    const infoHost = q(sr, 'bili-comment-user-info');
    const infoSr = getOpenShadow(infoHost);
    const img = q(infoSr, '#user-level img') || q(sr, '#user-level img');
    const src = img?.getAttribute('src') || '';
    const m = src.match(/level_(\d+)\.svg/i);
    return m ? Number(m[1]) : null;
  }

  function extractTextFromRichTextHost(richHost) {
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
    const richHost = q(sr, '#content bili-rich-text') || deepQueryAll(sr, 'bili-rich-text', 10)[0];
    const text = extractTextFromRichTextHost(richHost);
    if (!text) return null;

    const contentRoot = q(sr, '#content') || sr;
    const hasImage = !!(
      q(contentRoot, 'img') ||
      q(contentRoot, '[class*="image"]') ||
      q(contentRoot, 'bili-comment-image')
    );

    // 获取评论 DOM 元素以便插入按钮（直接返回整个renderer）
    return { uid, name: normalizeText(nameLink?.innerText || '未命名'), text, level, hasImage, element: commentRenderer };
  }

  function getAllCommentItems() {
    const threads = getThreadHosts();
    const items = [];
    for (const thread of threads) {
      const threadSr = getOpenShadow(thread);
      if (!threadSr) continue;
      const renderers = deepQueryAll(threadSr, 'bili-comment-renderer#comment', 30);
      for (const renderer of renderers) {
        const data = extractCommentDataFromRenderer(renderer);
        if (data) items.push(data);
      }
    }
    return items;
  }

  // ========== 按钮添加 ==========
  function tryAddButton(item) {
    const el = item.element;
    if (!el || el.querySelector('.bili-ad-cleaner-btn')) return;

    // 构造 detector 需要的数据
    const commentData = {
      content: item.text,
      level: item.level,
      avatarUrl: '' // 暂时不获取头像URL，不影响评分
    };

    const score = window.AdDetector.analyze(commentData);
    console.log('[清剿] 评分', score, item.text.slice(0, 40));

    if (score >= 60) {
      const btn = document.createElement('span');
      btn.className = 'bili-ad-cleaner-btn';
      btn.style.cssText = `
        margin-left:12px; color:#fff; background:#f25d8e; border-radius:4px;
        padding:2px 8px; font-size:12px; cursor:pointer; user-select:none;
      `;
      btn.textContent = '🚫 清剿';
      btn.title = '举报并拉黑该用户';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`确定举报并拉黑？\n${item.text.slice(0,60)}…`)) return;
        chrome.runtime.sendMessage({
          action: 'reportAndBlock',
          payload: {
            userId: item.uid,
            commentId: '', // Shadow DOM 不易获取 rpid，但后台可以尝试不传评论ID
            commentText: item.text
          }
        }, (resp) => {
          if (chrome.runtime.lastError) {
            alert('发送失败，请检查后台脚本');
            return;
          }
          if (resp?.success) {
            btn.textContent = '✅ 已清剿';
            btn.style.background = '#999';
            btn.disabled = true;
          } else {
            alert('失败：' + (resp?.error || '未知'));
          }
        });
      });

      // 插入到操作栏（Shadow DOM 内部）
      const sr = getOpenShadow(el);
      if (sr) {
        const ops = q(sr, '#footer .ops') || q(sr, '.reply-op') || q(sr, '[class*="oper"]');
        if (ops) {
          ops.appendChild(btn);
          return;
        }
      }
      // 备用：插入到渲染器外部（可能看不到）
      el.appendChild(btn);
    }
  }

  function scanAndMark() {
    const items = getAllCommentItems();
    console.log('[清剿] 扫描到评论数:', items.length);
    items.forEach(tryAddButton);
  }

  // ========== 动态监听 ==========
  function startObserve() {
    const container = document.querySelector('#comment') || document.body;
    const observer = new MutationObserver(() => {
      scanAndMark();
    });
    observer.observe(container, { childList: true, subtree: true });
    scanAndMark();
  }

  function waitForCommentArea() {
    let attempts = 0;
    const timer = setInterval(() => {
      const area = document.querySelector('#comment');
      if (area) {
        clearInterval(timer);
        startObserve();
      }
      if (++attempts > 30) clearInterval(timer);
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForCommentArea);
  } else {
    waitForCommentArea();
  }
})();