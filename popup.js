// popup.js – 控制自动清剿开关 + 重置贝叶斯模型
document.addEventListener("DOMContentLoaded", () => {
    const statusEl = document.getElementById("status");
    const autoToggle = document.getElementById("autoCleanToggle");
    const autoStatus = document.getElementById("autoStatus");
    const resetBtn = document.getElementById("resetBayesBtn");

    let currentTabId = null;

    // 获取当前标签页并初始化
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return;
        currentTabId = tab.id;
        const url = tab.url || "";
        const isBiliVideo = /bilibili\.com\/video\//.test(url);

        if (isBiliVideo) {
            statusEl.innerHTML =
                "✅ <strong>已检测到 B站 视频页面</strong> 插件正在运行。";
            statusEl.style.color = "#9df0b5";

            // 查询当前自动清剿状态
            chrome.tabs.sendMessage(
                currentTabId,
                { action: "getAutoCleanStatus" },
                (response) => {
                    if (chrome.runtime.lastError) return;
                    if (response?.active) {
                        autoToggle.checked = true;
                        autoStatus.textContent = "🔄 自动清剿运行中...";
                    }
                },
            );
        } else {
            statusEl.innerHTML =
                "⏸️ <strong>当前页面非 B站 视频页</strong><br>插件仅会在视频页生效。";
            statusEl.style.color = "#ffb86c";
            autoToggle.disabled = true;
            resetBtn.disabled = true;
        }
    });

    // 自动清剿开关
    autoToggle.addEventListener("change", () => {
        if (!currentTabId) {
            autoToggle.checked = !autoToggle.checked;
            alert("无法获取标签页，请尝试刷新页面后重试。");
            return;
        }
        const enable = autoToggle.checked;
        const action = enable ? "startAutoClean" : "stopAutoClean";
        chrome.tabs.sendMessage(currentTabId, { action }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                autoToggle.checked = !enable;
                autoStatus.textContent = "❌ 无法连接到页面，请刷新后重试。";
                return;
            }
            if (response?.ok) {
                autoStatus.textContent = enable
                    ? "✅ 自动清剿已启动，右上角可查看队列"
                    : "⏹️ 已停止自动清剿";
            } else {
                autoToggle.checked = !enable;
                autoStatus.textContent =
                    "❌ 操作失败：" + (response?.error || "未知错误");
            }
        });
    });

    // ========== 词库编辑功能 ==========
    const editBtn = document.getElementById("editKeywordsBtn");
    const editorDiv = document.getElementById("keywordEditor");
    const textarea = document.getElementById("keywordTextarea");
    const saveBtn = document.getElementById("saveKeywordsBtn");
    const cancelBtn = document.getElementById("cancelKeywordsBtn");

    // 打开编辑器
    editBtn.addEventListener("click", async () => {
        editorDiv.style.display = "block";
        editBtn.style.display = "none";

        const { userKeywords = [] } = await chrome.storage.local.get("userKeywords");
        textarea.value = (userKeywords || []).join("\n");
    });

    // 保存词库
    saveBtn.addEventListener("click", async () => {
        const lines = textarea.value.trim().split(/\n/);
        const keywords = lines.map(k => k.trim()).filter(k => k.length > 0);
        await chrome.storage.local.set({ userKeywords: keywords });
        if (currentTabId) {
            chrome.tabs.sendMessage(currentTabId, { action: "updateKeywords" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("更新词库通知失败:", chrome.runtime.lastError);
                }
            });
        }
        alert(`词库已保存，共 ${keywords.length} 个关键词。`);
        editorDiv.style.display = "none";
        editBtn.style.display = "block";
    });

    // 取消编辑
    cancelBtn.addEventListener("click", () => {
        editorDiv.style.display = "none";
        editBtn.style.display = "block";
    });

    // 重置贝叶斯模型
    resetBtn.addEventListener("click", () => {
        if (!currentTabId) {
            alert("无法获取标签页，请刷新页面后重试。");
            return;
        }
        if (confirm("⚠️ 确定要重置贝叶斯模型吗？\n这将清除所有已学习的广告/正常样本，模型将恢复冷启动状态。此操作不可撤销。")) {
            chrome.tabs.sendMessage(currentTabId, { action: "resetBayes" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError);
                    alert("重置失败，请刷新页面后重试。");
                    return;
                }
                if (response?.ok) {
                    alert("✅ 贝叶斯模型已重置。刷新页面后生效。");
                } else {
                    alert("重置失败：" + (response?.error || "未知错误"));
                }
            });
        }
    });
});