// content.js
(function () {
  'use strict';

  function tryParseAndMark(item) {
    if (item.querySelector('.bili-ad-cleaner-btn')) return;

    const data = window.AdDetector.parseCommentElement(item);
    
    // 增强日志：即使提取失败也输出
    if (!data.userId) {
      console.warn('[清剿] ❌ 未提取到userId', item);
      return;
    }

    const score = window.AdDetector.analyze(data);
    console.log(`[清剿] 评分=${score} | 内容=${data.content.slice(0, 40)}`);

    // 临时将阈值降至 30，确保绝大多数嫌疑评论都能出现按钮
    if (score >= 30) {
      const btn = document.createElement('span');
      btn.className = 'bili-ad-cleaner-btn';
      btn.style.cssText = `
        margin-left: 8px; color:#fff; background:#f25d8e; border-radius:4px;
        padding:1px 8px; font-size:12px; cursor:pointer; user-select:none;
      `;
      btn.textContent = '🚫 清剿';
      btn.title = '举报并拉黑';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`确定举报并拉黑？\n${data.content.slice(0, 60)}…`)) return;
        chrome.runtime.sendMessage({
          action: 'reportAndBlock',
          payload: {
            userId: data.userId,
            commentId: item.getAttribute('data-comment-id') || item.getAttribute('data-id') || '',
            commentText: data.content
          }
        }, (resp) => {
          if (chrome.runtime.lastError) {
            alert('发送失败：后台无响应');
            return;
          }
          if (resp?.success) {
            btn.textContent = '✅ 已清剿';
            btn.style.background = '#999';
            btn.disabled = true;
          } else {
            alert('操作失败：' + (resp?.error || '未知错误'));
          }
        });
      });

      // 尝试插入到操作栏（更宽泛的选择器）
      const ops = item.querySelector('.ops, .operation-area, .reply-op, [class*="oper"], .reply-btn');
      if (ops) {
        ops.parentElement?.appendChild(btn);
      } else {
        const contentEl = item.querySelector('.reply-content, .text');
        if (contentEl) contentEl.appendChild(btn);
      }
    }
  }

  function scanAll() {
    document.querySelectorAll('.reply-item, .comment-item, [data-user-id]').forEach(tryParseAndMark);
  }

  function startObserve() {
    const container = document.querySelector('#comment') || document.body;
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.matches?.('.reply-item, .comment-item, [data-user-id]')) {
              tryParseAndMark(node);
            } else {
              node.querySelectorAll?.('.reply-item, .comment-item, [data-user-id]').forEach(tryParseAndMark);
            }
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    scanAll();
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