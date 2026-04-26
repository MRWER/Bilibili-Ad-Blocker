// popup.js – 显示文档说明与状态检测
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');

  // 查询当前活动标签页的 URL，判断是否为 B站视频页
  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || '';
      const isBiliVideo = /bilibili\.com\/video\//.test(url);

      if (isBiliVideo) {
        statusEl.innerHTML = '✅ <strong>已检测到 B站 视频页面</strong><br>插件正在运行，滚动到评论区即可看到按钮。';
        statusEl.style.color = '#9df0b5';
      } else {
        statusEl.innerHTML = '⏸️ <strong>当前页面非 B站 视频页</strong><br>插件仅会在 <code>www.bilibili.com/video/...</code> 生效。';
        statusEl.style.color = '#ffb86c';
      }
    });
  } else {
    statusEl.textContent = '无法获取标签页信息。';
  }
});