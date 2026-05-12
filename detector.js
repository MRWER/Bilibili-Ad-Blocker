// detector.js – 优化版：文本预归一化 + 扩充词库 + 更精准的意图模式
const AdDetector = {

  // ─── 同音/形近字替换表（规避字符 → 标准字符）─────────────────────────────
  // 广告号常用以下替换来绕过关键词过滤，预处理时统一还原
  _homophones: [
    [/薇|葳|徽(?=信)|巍(?=信)/g,      '微'],
    [/芯(?=信)|馨(?=信)/g,             '微'],  // "芯信" → "微信"
    [/威(?=信|号)/g,                   '微'],
    [/讯(?=息)|讯$/g,                  '信'],
    [/扣\s*扣|叩\s*叩/g,              'QQ'],
    [/[Vv][Xx]|[Ww][Xx]/g,           '微信'],
    [/[Tt][Gg]\b/g,                   'Telegram'],
    [/[Dd][Dd](\d)/g,                 '私信$1'],
    // 全角转半角（Ａ-Ｚ ａ-ｚ ０-９ → ASCII）
    [/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248 + 65)],
    [/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248 + 97)],
    [/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248 + 48)],
    // 零宽字符、软连字符、BOM
    [/[\u200b-\u200f\u2060\ufeff\u00ad]/g, ''],
    // 常见字符间插空格绕过（"微 信" → "微信"）
    [/微\s+信/g, '微信'],
    [/Q\s+Q/gi,  'QQ'],
    [/q\s+q/gi,  'QQ'],
  ],

  // 对检测文本做预归一化，不改变显示层
  _normalize(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    for (const [pattern, replacement] of this._homophones) {
      t = t.replace(pattern, replacement);
    }
    return t;
  },

  // ─── 意图模式（regex + 分值）────────────────────────────────────────────
  intentPatterns: [
    // ① 利益诱导 + 行动词（核心引流结构）
    { name: '利益诱导+行动', score: 35,
      regex: /(免费|白嫖|领取|干货|资源|教程|方法|攻略|资料|福利|礼包).{0,12}(私|戳|扣|加|点|来|滴滴|dd|关注|群)/i },

    // ② 虚假紧迫感
    { name: '虚假紧迫感', score: 20,
      regex: /(名额|位置|只剩|最后|马上|快要|就要|即将|错过|再等).{0,5}(了|！|\d)/i },

    // ③ 虚假见证 / 真实性背书
    { name: '虚假见证', score: 25,
      regex: /(我之前|我本来|我朋友|闺蜜|舍友|同学|室友|媳妇).{0,12}(不信|结果|真的|竟然|发现|亲测|跟着|才知道)/i },

    // ④ 谐音 / 拆字规避联系方式
    { name: '谐音规避', score: 40,
      regex: /[vV]\s*[我]?\s*\d|扣\s*扣|微\s*信|q\s*q|群\s*号|[vV][xX][\s:：]?[a-zA-Z0-9_]/i },

    // ⑤ 引导去主页 / 私信
    { name: '主页/私信引流', score: 30,
      regex: /(主页|空间|私聊|私信|简介|动态|链接).{0,5}(有|看|见|给|发|留|找)/i },

    // ⑥ 可疑链接参数 / 非标域名
    { name: '可疑链接参数', score: 45,
      regex: /[?&]share_[a-z0-9]{10,}|[^\s]{8,}\.cn\b/i },

    // ⑦ 常见短链
    { name: '可疑短链', score: 40,
      regex: /(b23\.tv|t\.cn|dwz\.cn|suo\.im|fx\.bz|mrw\.so|url\.cn|tb\.cn)/i },

    // ⑧ 礼貌索取资源（常见伪装）
    { name: '求资源索图', score: 30,
      regex: /(老师|楼主|up|作者|大佬).{0,4}(礼拿|礼貌拿|可以拿|求图|求原图|求资源|发一下|分享一下|可以发|发我|私发)/i },

    // ⑨ 暗示离线获取
    { name: '暗示离线获取', score: 20,
      regex: /(想要|求|蹲).{0,3}(表情包|壁纸|头像|资源|教程|工具)|(我.{0,2}也.{0,2}(要|求))/i },

    // ⑩ 补字母引流（"常用英文后两位"等）
    { name: '补字母引流', score: 40,
      regex: /(补上|补充|带上|猜|首字母|后\d*英文|后\d*字母|小英文|常用英文|字母缩写).{0,5}[a-z]{2,4}/i },

    // ⑪ 网络加速 / 翻墙服务
    { name: '加速/翻墙服务', score: 35,
      regex: /(流畅的网|网速|加速|节点|不卡|稳如狗|流畅哦|流畅呀|网呀|冲浪|机场|梯子|vpn|vps|ss[ri]?)/i },

    // ⑫ 新人搭讪引流
    { name: '新人搭讪引流', score: 30,
      regex: /(大神们|大佬们|up主|帅哥|美女|宝子).{0,4}(给我|分享|发下|带带|求带|带我|可以拿|可以发|给个)/i },

    // ⑬ 水军特征（随机英文字母 + 表情）
    { name: '水军印记', score: 25,
      regex: /[a-z]{4,}\s?[😍💪👍🔥❤️✨🎁💰🤑]/ },

    // ⑭ 虚假使用体验吹捧
    { name: '虚假体验吹捧', score: 30,
      regex: /(都用几年|一直用|用了好几年|无比流畅|超级稳|超级流畅|超级好用|用了.*不后悔)/i },

    // ⑮ 回复数字 / 暗号引流（"回复666领取"）
    { name: '回复暗号引流', score: 35,
      regex: /(回复|评论|扣|留).{0,3}(\d{1,4}|"[^"]{1,6}"|【[^】]{1,8}】).{0,6}(领|取|发|送|获得|私)/i },

    // ⑯ 点赞/关注 + 私信互动（变现骗局）
    { name: '互动变现骗局', score: 30,
      regex: /(点赞|关注|收藏).{0,5}(私我|私信|找我|联系|加我).{0,10}(领|送|发|教|告诉)/i },

    // ⑰ 境外平台引流
    { name: '境外平台引流', score: 35,
      regex: /(telegram|tg|电报|whatsapp|ins|instagram|twitter|推特|discord|频道|社群)/i },

    // ⑱ 代理 / 招募话术
    { name: '代理招募', score: 40,
      regex: /(招(代理|合伙人|推广员)|兼职.*代理|代理.*招募|做代理|成为代理)/i },

    // ⑲ 截图/保存 + 抽奖（流量引导）
    { name: '截图抽奖', score: 25,
      regex: /(截图|保存|转发).{0,6}(抽奖|抽|中奖|送出|赠送)/i },

    // ⑳ 私发资料/课程
    { name: '私发课程资料', score: 30,
      regex: /(私发|私送|私聊领|私信.*?(课程|资料|文档|合集|整合|打包|合集))/i },
  ],

  // ─── 高危关键词（命中即 +50 分，只计一次）───────────────────────────────
  highRiskKeywords: [
    // 赌博 / 博彩
    '日赚', '月赚', '兼职', '刷单', '佣金', '投注', '赌博', '博彩', '彩票', '跑分',
    '洗钱', '套现', '提现秒到', '充值返利', '拉新奖励', '秒提', '躺赚', '被动收入',
    // 招募 / 传销相关
    '割韭菜', '无门槛', '招代理', '做任务赚钱', '推广赚钱', '宝妈在家',
    // 色情 / 擦边引流
    '私密照', '不雅', 'SP', '约啪', '附近妹子',
    // 其他高风险
    '解封', '黑号', '注册小号', '刷粉', '买粉', '真人粉',
  ],

  userKeywords: [],

  setUserKeywords(keywords) {
    this.userKeywords = Array.isArray(keywords) ? [...new Set(keywords)] : [];
  },

  // 强信号检测（作为快速预判，不依赖 analyze 完整流程）
  hasStrongAdSignals(text) {
    const t = this._normalize(text);
    return /(微信|QQ群?|Telegram|b23\.tv|加群|扫码|进群|私聊|→戳|点击链接|\d{6,})/i.test(t);
  },

  // 综合评分：对评论文本 + 用户画像特征打分（0-100）
  analyze(commentData) {
    let score = 0;
    const { content, level, avatarUrl } = commentData;

    // 先归一化，再做所有模式匹配
    const text = this._normalize(content || '');
    if (!text) return 0;

    // 意图模式打分
    for (const p of this.intentPatterns) {
      if (p.regex.test(text)) score += p.score;
    }

    // 高危关键词：命中任意一个即 +50，且只叠加一次
    for (const kw of this.highRiskKeywords) {
      if (text.includes(kw)) { score += 50; break; }
    }

    // 用户自定义词库：最多计 3 次，每次 +25
    const lowerText = text.toLowerCase();
    let userHitCount = 0;
    for (const kw of this.userKeywords) {
      if (kw && lowerText.includes(kw.toLowerCase())) {
        userHitCount++;
        if (userHitCount >= 3) break;
      }
    }
    if (userHitCount > 0) score += userHitCount * 25;

    // 用户画像辅助信号
    if (level !== undefined && level <= 2) score += 20;
    if (avatarUrl && (avatarUrl.includes('noface') || avatarUrl === '' || avatarUrl.endsWith('noFace.gif'))) score += 15;

    // 文本长度区间（广告评论通常不太长也不太短）
    if (text.length > 15 && text.length < 120) score += 5;

    // 过多表情符号
    const emojiCount = (text.match(/[\p{Emoji}\u200d]/gu) || []).length;
    if (emojiCount > 2) score += 8;

    return Math.min(score, 100);
  },
};

if (typeof window !== 'undefined') {
  window.AdDetector = AdDetector;
}
