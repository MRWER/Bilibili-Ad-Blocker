// background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'reportAndBlock') {
        // 使用新的处理函数
        handleReportAndBlockLatest(request.payload)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // 表示异步响应
    }
});

/**
 * 处理举报并拉黑操作 (2026年4月更新版)
 * @param {object} options - 操作选项
 * @param {string} options.userId - 目标用户ID (uid)
 * @param {string} options.commentId - 目标评论ID (rpid)
 * @param {string} options.commentText - 评论正文
 */
async function handleReportAndBlockLatest({ userId, commentId, commentText }) {
    // 从存储中读取用户的认证信息
    const { sessdata, biliJct } = await chrome.storage.local.get(['sessdata', 'biliJct']);
    if (!sessdata || !biliJct) {
        throw new Error('请先在插件设置中填入SESSDATA和bili_jct');
    }

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `SESSDATA=${sessdata}`,
        'Referer': 'https://www.bilibili.com/' // 建议添加，模拟真实请求
    };

    // 1. 举报评论 (新接口)
    if (commentId) {
        const reportBody = new URLSearchParams({
            oid: commentId,         // 评论的rpid
            type: 1,                // 1代表对视频评论的举报
            reason: 2,              // 2代表垃圾广告
            content: `[插件自动举报] 广告评论：${commentText}`,
            csrf: biliJct
        });
        try {
            const reportRes = await fetch('https://api.bilibili.com/x/v2/reply/report', {
                method: 'POST',
                headers,
                body: reportBody
            });
            const reportResult = await reportRes.json();
            if (reportResult.code !== 0) {
                console.error('举报API响应:', reportResult);
                throw new Error(`举报失败: ${reportResult.message || '未知错误'}`);
            }
            console.log('举报成功');
        } catch (error) {
            throw new Error(`举报请求受阻: ${error.message}`);
        }
    }

    // 2. 拉黑用户 (参数修正)
    const blockBody = new URLSearchParams({
        fid: userId,            // 用户ID
        act: 5,                // 5代表拉黑操作
        csrf: biliJct
    });
    // 注意：拉黑操作通常不需要re_src，若要加则需确认最新值
    try {
        const blockRes = await fetch('https://api.bilibili.com/x/relation/modify', {
            method: 'POST',
            headers,
            body: blockBody
        });
        const blockResult = await blockRes.json();
        if (blockResult.code !== 0) {
            console.error('拉黑API响应:', blockResult);
            throw new Error(`拉黑失败: ${blockResult.message || '未知错误'}`);
        }
        console.log('拉黑成功');
    } catch (error) {
        throw new Error(`拉黑请求受阻: ${error.message}`);
    }

    return { message: '操作已完成' };
}