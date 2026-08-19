// Indify content script — M1 骨架
// 注入 http://localhost/*(Dify 控制台):
//   1. 识别当前 app 上下文(appId / appName / mode / page / url)
//   2. 上报给 service worker({type:"indify:context"})
//   3. 响应 SW 的 ping({type:"indify:ping"})与"获取当前上下文"({type:"indify:getContext"})
//
// 页面分类:
//   - /app/{uuid}/workflow → page:"workflow",mode:"workflow"
//   - /apps                → page:"apps"(应用列表)
//   - /app/{uuid}/其它页    → page:"other"(仍提取 appId)
//   - 其余                → page:"other"

function extractAppName() {
  const title = (document.title || "").trim();
  if (!title) return undefined;
  // 常见形如 "应用名 - Dify" / "应用名 · Dify" / "应用名 | Dify";去掉品牌后缀
  const cleaned = title
    .replace(/\s*[-–—·|]\s*(Dify(?: · 开源)?|Dify Console).*$/i, "")
    .trim();
  return cleaned || undefined;
}

function detectContext() {
  const url = location.href;
  const path = location.pathname;

  const ctx = {
    url,
    page: "other",
  };

  // 提取 appId:/app/{uuid}/...
  const appMatch = path.match(/^\/app\/([0-9a-fA-F-]{8,})/);
  if (appMatch) {
    ctx.appId = appMatch[1];
  }

  if (/^\/apps(\/|$)/.test(path)) {
    // 应用列表页
    ctx.page = "apps";
  } else if (ctx.appId && /\/workflow(\/|$)/.test(path)) {
    // 工作流画布页
    ctx.page = "workflow";
    ctx.mode = "workflow";
  } else if (ctx.appId) {
    // 应用的其它页(overview / configuration 等),已提取 appId
    ctx.page = "other";
  } else {
    ctx.page = "other";
  }

  // 仅在具体 app 页才提取 appName;列表页无单一 app
  if (ctx.appId) {
    ctx.appName = extractAppName();
  }

  return ctx;
}

function reportContext() {
  try {
    chrome.runtime
      .sendMessage({ type: "indify:context", context: detectContext() })
      .catch(() => {});
  } catch (e) {
    // 扩展上下文不可用时静默(例如扩展被卸载瞬间)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "indify:ping") {
    // 存活探测 + 上下文刷新
    sendResponse({ type: "indify:pong", context: detectContext() });
    return true;
  }

  if (message.type === "indify:getContext") {
    // 显式获取当前上下文
    sendResponse({ type: "indify:context", context: detectContext() });
    return true;
  }

  // indify:status 等广播:忽略,不响应
});

// 页面加载完成(document_idle)即上报一次
reportContext();
