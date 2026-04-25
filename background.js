// background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'reportAndBlock') {
    handleReportAndBlock(request.payload)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 表示异步响应
  }
});

async function handleReportAndBlock({ userId, commentId, commentText }) {
  // 从存储中读取用户设置的认证信息
  const { sessdata, biliJct } = await chrome.storage.local.get(['sessdata', 'biliJct']);
  if (!sessdata || !biliJct) {
    throw new Error('请先在插件设置中填入SESSDATA和bili_jct');
  }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': `SESSDATA=${sessdata}`
  };

  // 1. 举报评论
  if (commentId) {
    const reportBody = new URLSearchParams({
      oid: commentId,
      type: 1,          // 1-视频评论
      reason: 2,        // 2-垃圾广告
      content: `[插件自动举报] 广告评论：${commentText}`,
      csrf: biliJct
    });
    const reportRes = await fetch('https://api.bilibili.com/x/web-interface/appeal/v2/submit', {
      method: 'POST',
      headers,
      body: reportBody
    });
    const reportResult = await reportRes.json();
    if (reportResult.code !== 0) {
      throw new Error(`举报失败: ${reportResult.message}`);
    }
  }

  // 2. 拉黑用户
  const blockBody = new URLSearchParams({
    fid: userId,
    act: 5,            // 5代表加入黑名单
    re_src: 11,        // 来源标识 (11: 视频)
    csrf: biliJct
  });
  const blockRes = await fetch('https://api.bilibili.com/x/relation/modify', {
    method: 'POST',
    headers,
    body: blockBody
  });
  const blockResult = await blockRes.json();
  if (blockResult.code !== 0) {
    throw new Error(`拉黑失败: ${blockResult.message}`);
  }

  return { reportCode: reportResult?.code, blockCode: blockResult.code };
}