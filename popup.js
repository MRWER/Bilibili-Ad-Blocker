// popup.js – 修复发送消息错误，支持实时自动清剿
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const autoToggle = document.getElementById('autoCleanToggle');
  const autoStatus = document.getElementById('autoStatus');
  let currentTabId = null;

  // 获取当前标签页并初始化
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    currentTabId = tab.id;
    const url = tab.url || '';
    const isBiliVideo = /bilibili\.com\/video\//.test(url);

    if (isBiliVideo) {
      statusEl.innerHTML = '✅ <strong>已检测到 B站 视频页面</strong><br>插件正在运行。';
      statusEl.style.color = '#9df0b5';

      // 查询当前自动清剿状态
      chrome.tabs.sendMessage(currentTabId, { action: 'getAutoCleanStatus' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response?.active) {
          autoToggle.checked = true;
          autoStatus.textContent = '🔄 自动清剿运行中...';
        }
      });
    } else {
      statusEl.innerHTML = '⏸️ <strong>当前页面非 B站 视频页</strong><br>插件仅会在视频页生效。';
      statusEl.style.color = '#ffb86c';
      autoToggle.disabled = true;
    }
  });

  // 复选框切换
  autoToggle.addEventListener('change', () => {
    if (!currentTabId) {
      autoToggle.checked = !autoToggle.checked; // 恢复原状态
      alert('无法获取标签页，请尝试刷新页面后重试。');
      return;
    }

    const enable = autoToggle.checked;
    const action = enable ? 'startAutoClean' : 'stopAutoClean';
    chrome.tabs.sendMessage(currentTabId, { action }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        autoToggle.checked = !enable;
        autoStatus.textContent = '❌ 无法连接到页面，请刷新后重试。';
        return;
      }
      if (response?.ok) {
        autoStatus.textContent = enable ? '✅ 自动清剿已启动，右上角可查看队列' : '⏹️ 已停止自动清剿';
      } else {
        autoToggle.checked = !enable;
        autoStatus.textContent = '❌ 操作失败：' + (response?.error || '未知错误');
      }
    });
  });
});