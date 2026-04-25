// detector.js
const AdDetector = {
  intentPatterns: [
    // 原有模式保持不变
    { name: '利益诱导+行动', regex: /(免费|白嫖|领取|干货|资源|教程|方法|攻略|资料).{0,10}(私|戳|扣|加|点|看|来|滴滴|dd|关注)/i, score: 35 },
    { name: '虚假紧迫感', regex: /(名额|位置|只剩|最后|马上|快要|就要|即将|错过|再等).{0,5}(了|！|\d)/i, score: 20 },
    { name: '虚假见证', regex: /(我之前|我本来|我朋友|闺蜜|舍友|同学).{0,10}(不信|结果|真的|竟然|发现|亲测|跟着)/i, score: 25 },
    { name: '谐音规避', regex: /[vV]\s*[我]\s*\d|扣\s*扣|微\s*信|q\s*q|群\s*号/i, score: 40 },
    { name: '主页/私信引流', regex: /(主页|空间|私聊|私信|简介|动态).{0,5}(有|看|见|给|发|留)/i, score: 30 },
    { name: '可疑乱码链接', regex: /[?&]share_[a-z0-9]+|[^\s]{15,}\.com|[^\s]{8,}\.cn/i, score: 45 },
    { name: '求图求资源', regex: /(老师|楼主|up|作者|大佬).{0,4}(礼拿|礼貌拿|可以拿|求图|求原图|求资源|发一下|分享一下|可以发|发我|私发)/i, score: 30 },
    { name: '暗示离线获取', regex: /(想要|求|蹲).{0,3}(表情包|壁纸|头像|资源|教程|工具)|(我.{0,2}也.{0,2}(要|求))/i, score: 20 },
  ],
  highRiskKeywords: ['日赚', '兼职', '刷单', '佣金', '投注', '赌博'],

  analyze(commentData) {
    let score = 0;
    const { content, level, avatarUrl } = commentData;
    const text = content.trim();

    for (const p of this.intentPatterns) {
      if (p.regex.test(text)) score += p.score;
    }
    for (const kw of this.highRiskKeywords) {
      if (text.includes(kw)) { score += 50; break; }
    }
    if (level !== undefined && level <= 2) score += 15;
    if (avatarUrl && (avatarUrl.includes('noface') || avatarUrl === '' || avatarUrl.endsWith('noFace.gif'))) score += 15;
    if (text.length > 15 && text.length < 120) score += 5;
    const emojiCount = (text.match(/[\p{Emoji}\u200d]/gu) || []).length;
    if (emojiCount > 3) score += 8;

    return Math.min(score, 100);
  },

  parseCommentElement(element) {
    // 1. 内容提取
    const textEl = element.querySelector('.reply-content, .text, .reply-text');
    const content = textEl ? textEl.innerText : '';

    // 2. 用户ID提取（多路备用）
    let userId = null;
    const userLink = element.querySelector('a.user-name, [class*="user-name"]');
    if (userLink) {
      userId = userLink.getAttribute('data-user-id') || userLink.getAttribute('data-uid');
    }
    if (!userId) {
      // 尝试从 space 链接提取
      const spaceHref = element.querySelector('a[href*="space.bilibili.com"]')?.href;
      if (spaceHref) {
        const match = spaceHref.match(/space\.bilibili\.com\/(\d+)/);
        if (match) userId = match[1];
      }
    }

    // 3. 等级提取
    let level = undefined;
    const levelEl = element.querySelector('.level i, .user-level, [class*="level"]');
    if (levelEl) {
      const cm = levelEl.className.match(/level-(\d+)/);
      if (cm) level = parseInt(cm[1]);
    }

    // 4. 头像URL
    const avatarImg = element.querySelector('.bili-avatar-img img, .user-avatar img, img[src*="face"]');
    const avatarUrl = avatarImg ? avatarImg.src : '';

    return { content, userId, level, avatarUrl };
  }
};

if (typeof window !== 'undefined') {
  window.AdDetector = AdDetector;
}