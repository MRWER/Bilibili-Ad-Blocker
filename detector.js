// detector.js – 规则检测 + 增量朴素贝叶斯分类器（在线学习）
const AdDetector = {
    // ─── 同音/形近字替换表（归一化）─────────────────────────────────────────
    _homophones: [
        [/薇|葳|徽(?=信)|巍(?=信)/g, "微"],
        [/芯(?=信)|馨(?=信)/g, "微"],
        [/威(?=信|号)/g, "微"],
        [/讯(?=息)|讯$/g, "信"],
        [/扣\s*扣|叩\s*叩/g, "QQ"],
        // [/[Vv][Xx]|[Ww][Xx]/g, "微信"],
        [/[Tt][Gg]\b/g, "Telegram"],
        [/[Dd][Dd](\d)/g, "私信$1"],
        [/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248 + 65)],
        [/[ａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248 + 97)],
        [/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248 + 48)],
        [/[\u200b-\u200f\u2060\ufeff\u00ad]/g, ""],
        [/微\s+信/g, "微信"],
        [/Q\s+Q/gi, "QQ"],
        [/q\s+q/gi, "QQ"],
    ],

    _normalize(text) {
        let t = String(text || "")
            .replace(/\s+/g, " ")
            .trim();
        for (const [pattern, replacement] of this._homophones) {
            t = t.replace(pattern, replacement);
        }
        return t;
    },

    // ─── 规则模式（保留原有）───────────────────────────────────────────────
    intentPatterns: [
        { name: "利益诱导+行动", score: 35, regex: /(免费|白嫖|领取|干货|资源|教程|方法|攻略|资料|福利|礼包).{0,12}(私|戳|扣|加|点|来|滴滴|dd|关注|群)/i },
        { name: "虚假紧迫感", score: 20, regex: /(名额|位置|只剩|最后|马上|快要|就要|即将|错过|再等).{0,5}(了|！|\d)/i },
        { name: "虚假见证", score: 25, regex: /(我之前|我本来|我朋友|闺蜜|舍友|同学|室友|媳妇).{0,12}(不信|结果|真的|竟然|发现|亲测|跟着|才知道)/i },
        { name: "谐音规避", score: 40, regex: /[vV]\s*[我]?\s*\d|(?:扣\s*扣|q\s*q)\s*(?:群|号|\d+)|微\s*信|群\s*号|[vV][xX][\s:：]?[a-zA-Z0-9_]/i },
        { name: "主页/私信引流", score: 30, regex: /(主页|空间|私聊|私信|简介|动态|链接).{0,5}(有|看|见|给|发|留|找)/i },
        { name: "可疑链接参数", score: 45, regex: /[?&]share_[a-z0-9]{10,}|[^\s]{8,}\.cn\b/i },
        { name: "可疑短链", score: 40, regex: /(b23\.tv|t\.cn|dwz\.cn|suo\.im|fx\.bz|mrw\.so|url\.cn|tb\.cn)/i },
        { name: "求资源索图", score: 30, regex: /(老师|楼主|up|作者|大佬).{0,4}(礼拿|礼貌拿|可以拿|求图|求原图|求资源|发一下|分享一下|可以发|发我|私发)/i },
        { name: "暗示离线获取", score: 20, regex: /(想要|求|蹲).{0,3}(表情包|壁纸|头像|资源|教程|工具)|(我.{0,2}也.{0,2}(要|求))/i },
        { name: "补字母引流", score: 40, regex: /(补上|补充|带上|猜|首字母|后\d*英文|后\d*字母|小英文|常用英文|字母缩写).{0,5}[a-z]{2,4}/i },
        { name: "加速/翻墙服务", score: 35, regex: /(流畅的网|网速|加速|节点|不卡|稳如狗|流畅哦|流畅呀|网呀|冲浪|机场|梯子|vpn|vps|ss[ri]?)/i },
        { name: "新人搭讪引流", score: 30, regex: /(大神们|大佬们|up主|帅哥|美女|宝子).{0,4}(给我|分享|发下|带带|求带|带我|可以拿|可以发|给个)/i },
        { name: "水军印记", score: 25, regex: /[a-z]{4,}\s?[😍💪👍🔥❤️✨🎁💰🤑]/ },
        { name: "虚假体验吹捧", score: 30, regex: /(都用几年|一直用|用了好几年|无比流畅|超级稳|超级流畅|超级好用|用了.*不后悔)/i },
        { name: "回复暗号引流", score: 35, regex: /(回复|评论|扣|留).{0,3}(\d{1,4}|"[^"]{1,6}"|【[^】]{1,8}】).{0,6}(领|取|发|送|获得|私)/i },
        { name: "互动变现骗局", score: 30, regex: /(点赞|关注|收藏).{0,5}(私我|私信|找我|联系|加我).{0,10}(领|送|发|教|告诉)/i },
        { name: "境外平台引流", score: 35, regex: /(telegram|tg|电报|whatsapp|ins|instagram|twitter|推特|discord|频道|社群)/i },
        { name: "代理招募", score: 40, regex: /(招(代理|合伙人|推广员)|兼职.*代理|代理.*招募|做代理|成为代理)/i },
        { name: "截图抽奖", score: 25, regex: /(截图|保存|转发).{0,6}(抽奖|抽|中奖|送出|赠送)/i },
        { name: "私发课程资料", score: 30, regex: /(私发|私送|私聊领|私信.*?(课程|资料|文档|合集|整合|打包|合集))/i },
        { name: "无意义呼唤", score: 15, regex: /(?:我的)?(?:爸爸|哥哥|妈妈|姐姐|妹妹)(?:呢|在哪|哪里|去哪)?$|^给$/i },
    ],

    highRiskKeywords: [
        "日赚", "月赚", "兼职", "刷单", "佣金", "投注", "赌博", "博彩", "彩票",
        "跑分", "洗钱", "套现", "提现秒到", "充值返利", "拉新奖励", "秒提", "躺赚",
        "被动收入", "割韭菜", "无门槛", "招代理", "做任务赚钱", "推广赚钱", "宝妈在家",
        "私密照", "不雅", "SP", "约啪", "附近妹子", "解封", "黑号", "注册小号",
        "刷粉", "买粉", "真人粉", "挂机赚钱", "自动赚钱", "智能赚钱", "AI赚钱", "求给一个出处",
        "谁看", "给看"
    ],

    userKeywords: [],

    setUserKeywords(keywords) {
        this.userKeywords = Array.isArray(keywords) ? [...new Set(keywords)] : [];
    },

    hasStrongAdSignals(text) {
        const t = this._normalize(text);
        return /(微信|QQ群|Telegram|b23\.tv|加群|扫码|进群|私聊|→戳|点击链接|(?:我的)?(?:爸爸|哥哥|妈妈|姐姐|妹妹)(?:呢|在哪|哪里|去哪)?\s*$|^给\s*$)/i.test(t);
    },

    // 规则评分 (0-100)
    analyzeRule(text, level, avatarUrl) {
        let score = 0;
        const t = this._normalize(text || "");
        if (!t) return 0;

        for (const p of this.intentPatterns) {
            if (p.regex.test(t)) score += p.score;
        }
        for (const kw of this.highRiskKeywords) {
            if (t.includes(kw)) { score += 50; break; }
        }
        const lowerText = t.toLowerCase();
        let userHit = 0;
        for (const kw of this.userKeywords) {
            if (lowerText.includes(kw.toLowerCase())) { userHit++; if (userHit >= 3) break; }
        }
        score += userHit * 25;

        if (level !== undefined && level <= 2) score += 20;
        if (avatarUrl && (avatarUrl.includes("noface") || avatarUrl === "" || avatarUrl.endsWith("noFace.gif"))) score += 15;
        if (t.length > 15 && t.length < 120) score += 5;
        const emojiCount = (t.match(/[\p{Emoji}\u200d]/gu) || []).length;
        if (emojiCount > 2) score += 8;

        return Math.min(score, 100);
    },

    // 最终评分（融合贝叶斯）
    async analyze(commentData) {
        const { content, level, avatarUrl, features } = commentData;
        const ruleScore = this.analyzeRule(content, level, avatarUrl);

        // 如果贝叶斯分类器未就绪或样本不足，直接返回规则分
        if (!window.BayesClassifier || !window.BayesClassifier.isReady()) {
            return ruleScore;
        }

        let bayesProb = 0.5; // 默认中性
        try {
            // 特征可以是预先提取好的，也可以临时提取
            const feat = features || this.extractFeatures(content);
            bayesProb = await window.BayesClassifier.predict(feat);
        } catch (e) {
            console.warn("[贝叶斯] 预测失败", e);
        }

        // 融合：规则分0-100映射到0-1，与贝叶斯概率加权（规则0.6，贝叶斯0.4）
        const ruleProb = ruleScore / 100;
        const fusedProb = 0.6 * ruleProb + 0.4 * bayesProb;
        let finalScore = Math.round(fusedProb * 100);
        finalScore = Math.min(100, Math.max(0, finalScore));
        return finalScore;
    },

    // 从文本中提取特征（词袋，哈希）
    extractFeatures(text) {
        const norm = this._normalize(text);
        // 简单分词：按非字母数字中文分隔
        const words = norm.split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/).filter(w => w.length >= 2);
        const bigrams = [];
        for (let i = 0; i < words.length - 1; i++) {
            bigrams.push(words[i] + words[i+1]);
        }
        const allTokens = [...words, ...bigrams];
        // 去重
        return [...new Set(allTokens)];
    }
};

// ───────────────────────────────────────────────────────────
// 增量朴素贝叶斯分类器（在线学习，本地存储）
// ───────────────────────────────────────────────────────────
class IncrementalNaiveBayes {
    constructor(hashSize = 10000) {
        this.hashSize = hashSize;
        // 特征计数：{ ad: Map<index, count>, normal: Map<index, count> }
        this.featureCounts = { ad: new Map(), normal: new Map() };
        this.classCounts = { ad: 0, normal: 0 };
        this.totalDocs = 0;
        this.minSamples = 20;   // 最少样本数才启用预测
        this.smooth = 1;        // 拉普拉斯平滑
    }

    // 哈希函数
    _hash(word) {
        let hash = 0;
        for (let i = 0; i < word.length; i++) {
            hash = ((hash << 5) - hash) + word.charCodeAt(i);
            hash |= 0; // 转32位整数
        }
        return Math.abs(hash) % this.hashSize;
    }

    // 更新模型（增量学习）
    update(features, label) {
        const map = this.featureCounts[label];
        for (const feat of features) {
            const idx = this._hash(feat);
            map.set(idx, (map.get(idx) || 0) + 1);
        }
        this.classCounts[label]++;
        this.totalDocs++;
        this._save();
    }

    // 预测概率 (0~1) 表示是广告的可能性
    predict(features) {
        if (this.totalDocs < this.minSamples) return 0.5; // 样本不足，返回中性

        const vocabSize = this.hashSize;
        const priorAd = Math.log(this.classCounts.ad / this.totalDocs);
        const priorNormal = Math.log(this.classCounts.normal / this.totalDocs);

        let logProbAd = priorAd;
        let logProbNormal = priorNormal;

        for (const feat of features) {
            const idx = this._hash(feat);
            const adCount = this.featureCounts.ad.get(idx) || 0;
            const normalCount = this.featureCounts.normal.get(idx) || 0;

            const probAd = (adCount + this.smooth) / (this.classCounts.ad + this.smooth * vocabSize);
            const probNormal = (normalCount + this.smooth) / (this.classCounts.normal + this.smooth * vocabSize);

            logProbAd += Math.log(probAd);
            logProbNormal += Math.log(probNormal);
        }

        // 防止数值下溢，使用 sigmoid 将 log-odds 转为概率
        const logOdds = logProbAd - logProbNormal;
        // 裁剪防止 exp 溢出
        const clipped = Math.min(709, Math.max(-709, logOdds));
        return 1 / (1 + Math.exp(-clipped));
    }

    // 判断是否可用（样本足够）
    isReady() {
        return this.totalDocs >= this.minSamples;
    }

    // 保存到 chrome.storage.local（Map 需转成普通对象）
    async _save() {
        const toStore = {
            hashSize: this.hashSize,
            classCounts: this.classCounts,
            totalDocs: this.totalDocs,
            minSamples: this.minSamples,
            smooth: this.smooth,
            featureCounts: {
                ad: Object.fromEntries(this.featureCounts.ad),
                normal: Object.fromEntries(this.featureCounts.normal)
            }
        };
        await chrome.storage.local.set({ bayes_model: toStore });
    }

    // 从存储加载（静态方法）
    static async load() {
        const { bayes_model } = await chrome.storage.local.get('bayes_model');
        if (!bayes_model) return new IncrementalNaiveBayes();

        const classifier = new IncrementalNaiveBayes(bayes_model.hashSize || 10000);
        classifier.classCounts = bayes_model.classCounts || { ad: 0, normal: 0 };
        classifier.totalDocs = bayes_model.totalDocs || 0;
        classifier.minSamples = bayes_model.minSamples || 20;
        classifier.smooth = bayes_model.smooth || 1;

        // 恢复 Map
        classifier.featureCounts.ad = new Map(Object.entries(bayes_model.featureCounts?.ad || {}));
        classifier.featureCounts.normal = new Map(Object.entries(bayes_model.featureCounts?.normal || {}));
        return classifier;
    }

    // 重置模型（可选，用于调试）
    async reset() {
        this.featureCounts = { ad: new Map(), normal: new Map() };
        this.classCounts = { ad: 0, normal: 0 };
        this.totalDocs = 0;
        await this._save();
    }
}

// 全局暴露
window.AdDetector = AdDetector;
window.BayesClassifier = null; // 将在 content.js 初始化时赋值

// 导出（供 content.js 使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AdDetector, IncrementalNaiveBayes };
}