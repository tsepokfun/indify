// Indify side panel — M1 骨架
// 从 SW 拉状态 / 订阅 chrome.runtime.onMessage 渲染状态;无外部依赖,纯 JS。

const els = {
  bridgeDot: document.getElementById("bridge-dot"),
  bridgeText: document.getElementById("bridge-text"),
  contextText: document.getElementById("context-text"),
  tokenBox: document.getElementById("token-box"),
  tokenInput: document.getElementById("token-input"),
  tokenSave: document.getElementById("token-save"),
};

function formatContext(ctx) {
  if (!ctx || !ctx.url) return "未检测到 Dify 页面(请打开 http://localhost)";
  const parts = [];
  if (ctx.appId) parts.push(`appId=${ctx.appId}`);
  if (ctx.appName) parts.push(`应用=${ctx.appName}`);
  if (ctx.mode) parts.push(`模式=${ctx.mode}`);
  parts.push(`页面=${ctx.page}`);
  return parts.join(" · ");
}

function renderStatus(status) {
  const bridge = status.bridge || {};
  const ctx = status.context || {};

  if (bridge.connected) {
    els.bridgeDot.className = "dot dot-ok";
    els.bridgeText.textContent = "Bridge 已连接";
    els.tokenBox.classList.remove("show");
  } else {
    els.bridgeDot.className = "dot dot-off";
    els.bridgeText.textContent = "Bridge 未连接";
    // 未连接时提供 token 粘贴入口(可能因无 token 被 Bridge 拒握手)
    els.tokenBox.classList.add("show");
  }
  els.bridgeText.title = bridge.url || "";

  els.contextText.textContent = formatContext(ctx);
}

// token 保存 → 写入 chrome.storage.local → SW 监听到变更后自动重连
els.tokenSave.addEventListener("click", async () => {
  const token = els.tokenInput.value.trim();
  if (!token) return;
  try {
    await chrome.storage.local.set({ bridgeToken: token });
    els.tokenInput.value = "";
    els.bridgeText.textContent = "token 已保存,重连中…";
  } catch (e) {
    console.warn("[Indify] token 保存失败:", e);
  }
});

async function init() {
  // 1) 先读 storage.session 恢复上一次状态,避免"未连接"闪屏
  try {
    const data = await chrome.storage.session.get(["bridge", "context"]);
    renderStatus({
      bridge: data.bridge || {},
      context: data.context || {},
    });
  } catch (e) {
    console.warn("[Indify] 读取缓存状态失败:", e);
  }

  // 2) 请求 SW 广播最新状态(触发广播 indify:status)
  try {
    chrome.runtime.sendMessage({ type: "indify:getStatus" }).catch(() => {});
  } catch (e) {
    /* 忽略 */
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "indify:status") {
    renderStatus(message);
  }
});

init();
