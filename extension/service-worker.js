// Indify service worker — M1 骨架
// 职责:
//   1. 持有与 Indify Bridge 的 WebSocket 连接(ws://127.0.0.1:39181/v1/events)
//   2. 断线指数退避重连(1s/2s/4s/…封顶 30s)+ 心跳保活
//   3. 对外广播状态(chrome.runtime.sendMessage → {type:"indify:status"})
//   4. 监听 content script 上报的应用上下文,并按需 ping / 拉取最新上下文
// 注意:M2 起在此解析 Bridge 的任务进度帧(task.progress / task.result / …)。

const BRIDGE_WS_URL = "ws://127.0.0.1:39181/v1/events";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 20000; // 心跳发送间隔
const STALE_THRESHOLD_MS = 60000; // 超过该时长未收到任何帧,判定连接僵死,强制重连
const CONTEXT_REFRESH_INTERVAL_MS = 30000; // 周期 ping content script 刷新上下文

let bridgeState = {
  connected: false,
  url: BRIDGE_WS_URL,
};

let context = {}; // 最近一次 content script 上报的应用上下文
let contextTabId = null; // 上报上下文的标签页 id

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let heartbeatTimer = null;
let contextRefreshTimer = null;
let lastActivityAt = 0;

// ---------- 状态持久化(面板重开可恢复) ----------
async function persistState() {
  try {
    await chrome.storage.session.set({
      bridge: bridgeState,
      context: context,
    });
  } catch (e) {
    // storage.session 偶发不可用时降级为纯内存态,不影响骨架运行
    console.warn("[Indify] persistState 失败:", e);
  }
}

async function restoreState() {
  try {
    const data = await chrome.storage.session.get(["bridge", "context"]);
    if (data && data.bridge) {
      bridgeState = { ...bridgeState, ...data.bridge };
      // 持久化的 connected 只反映历史状态;连接生命周期由本 SW 实时维护,
      // 启动时先恢复为未连接,待 connect() 成功后再翻转为 true。
      bridgeState.connected = false;
    }
    if (data && data.context) {
      context = data.context;
    }
  } catch (e) {
    console.warn("[Indify] restoreState 失败:", e);
  }
}

// ---------- 状态广播 ----------
function broadcastStatus() {
  const message = {
    type: "indify:status",
    bridge: { ...bridgeState },
    context: { ...context },
  };
  // 广播到所有扩展上下文(panel / content script);无接收者时静默失败
  chrome.runtime.sendMessage(message).catch(() => {});
  persistState();
}

// ---------- WebSocket 连接 ----------
// Bridge 认证:token 存于 chrome.storage.local.bridgeToken(用户安装时粘贴,
// 值在 .indifyrc.yaml);未配置时按无 token 连接,Bridge 会拒绝握手(状态显示未连接)。
async function buildWsUrl() {
  try {
    const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
    if (bridgeToken && typeof bridgeToken === "string" && bridgeToken.length >= 16) {
      return `${BRIDGE_WS_URL}?token=${encodeURIComponent(bridgeToken)}`;
    }
  } catch (e) {
    // 忽略,退回无 token 连接
  }
  return BRIDGE_WS_URL;
}

async function connect() {
  clearReconnectTimer();
  const url = await buildWsUrl();
  try {
    ws = new WebSocket(url);
  } catch (e) {
    // 环境不支持或 URL 非法
    console.warn("[Indify] 创建 WebSocket 失败:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS; // 连接成功,重置退避
    lastActivityAt = Date.now();
    bridgeState = { ...bridgeState, connected: true, url };
    startHeartbeat();
    broadcastStatus();
    console.info("[Indify] Bridge 已连接:", url);
  };

  ws.onmessage = (event) => {
    lastActivityAt = Date.now();
    // 骨架阶段只记录;M2 起在此解析 Bridge 的任务进度帧
    console.debug(
      "[Indify] ws 帧:",
      typeof event.data === "string" ? event.data : "(binary)"
    );
  };

  ws.onerror = () => {
    // WebSocket 规范:onerror 后必然触发 onclose,重连统一由 onclose 处理
    console.warn("[Indify] ws error");
  };

  ws.onclose = () => {
    bridgeState = { ...bridgeState, connected: false };
    stopHeartbeat();
    broadcastStatus();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  bridgeState = { ...bridgeState, connected: false };
  console.info(`[Indify] ${reconnectDelay}ms 后重连 Bridge...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ---------- 心跳 ----------
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // 客户端心跳帧:M2 与 Bridge 对齐帧格式前,此为占位
    try {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    } catch (e) {
      console.warn("[Indify] 心跳发送失败:", e);
    }

    // 判死:长时间无任何帧 → 强制关闭,触发 onclose → 重连
    if (Date.now() - lastActivityAt > STALE_THRESHOLD_MS) {
      console.warn("[Indify] 连接疑似僵死,强制重连");
      try {
        ws.close();
      } catch (e) {
        /* 忽略 */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------- content script 上下文刷新 ----------
// 向已跟踪的 Dify 标签页发消息(messageType = indify:getContext | indify:ping),
// 用其响应刷新本 SW 缓存的 context。
async function requestContextFromContent(messageType) {
  if (contextTabId == null) return false;
  try {
    const response = await chrome.tabs.sendMessage(contextTabId, {
      type: messageType,
    });
    if (response && response.context) {
      context = { ...response.context };
      broadcastStatus();
      return true;
    }
  } catch (e) {
    // 标签页已关闭或 content script 未注入:忽略,保留最后一次已知上下文
  }
  return false;
}

function startContextRefresh() {
  if (contextRefreshTimer) return;
  contextRefreshTimer = setInterval(() => {
    requestContextFromContent("indify:ping");
  }, CONTEXT_REFRESH_INTERVAL_MS);
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "indify:context": {
      // content script 上报应用上下文
      context = { ...(message.context || {}) };
      if (sender.tab && sender.tab.id != null) contextTabId = sender.tab.id;
      broadcastStatus();
      break;
    }
    case "indify:getStatus": {
      // panel 请求当前状态:先广播当前快照,再向 content script 拉取新鲜上下文
      broadcastStatus();
      requestContextFromContent("indify:getContext");
      break;
    }
    default:
      break;
  }
  // 不 sendResponse;状态通过广播送达
});

// ---------- 标签页生命周期 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === contextTabId) {
    contextTabId = null;
    // 保留最后上下文仅供展示;M2 起可在此清理过期状态
  }
});

// token 变更(panel 保存)→ 立即重连
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeToken) {
    console.info("[Indify] bridgeToken 已更新,重连...");
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* 忽略 */
      }
    }
    reconnectDelay = RECONNECT_BASE_MS;
    connect();
  }
});

// ---------- 点击扩展图标 → 打开侧边栏 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---------- 启动 ----------
(async function init() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await restoreState();
  broadcastStatus(); // 立即对外广播(含未连接的 Bridge 状态与缓存上下文)
  connect();
  startContextRefresh();
})();
