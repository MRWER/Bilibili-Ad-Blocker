// popup.js
document.addEventListener('DOMContentLoaded', () => {
  // 加载已保存的值
  chrome.storage.local.get(['sessdata', 'biliJct'], (items) => {
    document.getElementById('sessdata').value = items.sessdata || '';
    document.getElementById('biliJct').value = items.biliJct || '';
  });

  document.getElementById('save').addEventListener('click', () => {
    const sessdata = document.getElementById('sessdata').value.trim();
    const biliJct = document.getElementById('biliJct').value.trim();
    chrome.storage.local.set({ sessdata, biliJct }, () => {
      alert('保存成功！');
    });
  });

  document.getElementById('guide').addEventListener('click', (e) => {
    e.preventDefault();
    alert('1. 登录B站\n2. 按F12打开控制台\n3. 进入“应用”(Application) -> Cookie -> bilibili.com\n4. 找到SESSDATA和bili_jct，复制值。\n注意：不要泄露！');
  });
});