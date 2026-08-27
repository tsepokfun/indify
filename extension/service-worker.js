// Indify service worker — M3(新建 U1 + 就地修改 U2 + 续聊 U3)
// 职责:
//   1. 持有与 Indify Bridge 的 WebSocket 连接(ws://127.0.0.1:39181/v1/events)
//   2. 断线指数退避重连(1s/2s/4s/…封顶 30s)+ 心跳保活
//   3. HTTP 调用封装 bridgeFetch(BASE=http://127.0.0.1:39181,token 在 storage.local.bridgeToken)
//   4. 任务路由:submitTask(create/modify)/ decision / getArtifact / getAdapter / retryInject / newSession
//   5. 解析 WS 的 task.frame → 广播给面板;status 变 ready 时按 mode 自动触发注入编排(幂等)
//   6. sessionId 透传(U3):storage.session.lastSessionId,任务 done 后更新
//   7. 监听 content script 上报的应用上下文

const BRIDGE_WS_URL = "ws://127.0.0.1:39181/v1/events";
const BRIDGE_BASE = "http://127.0.0.1:39181";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 20000; // 心跳发送间隔
const STALE_THRESHOLD_MS = 60000; // 超过该时长未收到任何帧,判定连接僵死,强制重连
const CONTEXT_REFRESH_INTERVAL_MS = 30000; // 周期 ping content script 刷新上下文
// 版本防波堤纪律:这里不硬编码任何 Dify/DSL 版本;adapter 由运行时探测选择(见 getAdapter)。

let bridgeState = {
  connected: false,
  url: BRIDGE_WS_URL,
};

let context = {}; // 最近一次 content script 上报的应用上下文
let contextTabId = null; // 上报上下文的标签页 id

let currentTask = null; // 当前任务(含 inject 子状态、mode、context 快照),持久化到 storage.session
let injectedTaskIds = new Set(); // 已完成注入编排的任务,保证 ready 帧幂等
let lastSessionId = null; // U3:最近一次任务的 DSH 会话 id,提交时透传

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let heartbeatTimer = null;
let contextRefreshTimer = null;
let lastActivityAt = 0;

let adapterCache = null; // adapter JSON 内存缓存(亦落 storage.local)

// ---------- 状态持久化(面板重开可恢复) ----------
async function persistState() {
  try {
    await chrome.storage.session.set({
      bridge: bridgeState,
      context: context,
      currentTask: currentTask,
      injectedTasks: [...injectedTaskIds],
      lastSessionId: lastSessionId,
    });
  } catch (e) {
    console.warn("[Indify] persistState 失败:", e);
  }
}

async function restoreState() {
  try {
    const data = await chrome.storage.session.get([
      "bridge",
      "context",
      "currentTask",
      "injectedTasks",
      "lastSessionId",
    ]);
    if (data && data.bridge) {
      bridgeState = { ...bridgeState, ...data.bridge };
      bridgeState.connected = false; // 连接生命周期由本 SW 实时维护
    }
    if (data && data.context) context = data.context;
    if (data && data.currentTask) currentTask = data.currentTask;
    if (Array.isArray(data && data.injectedTasks)) {
      injectedTaskIds = new Set(data.injectedTasks);
    }
    if (data && data.lastSessionId) lastSessionId = data.lastSessionId;
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
    lastSessionId: lastSessionId,
  };
  chrome.runtime.sendMessage(message).catch(() => {});
  persistState();
}

function broadcastTask(task) {
  chrome.runtime
    .sendMessage({ type: "indify:task", task: { ...task } })
    .catch(() => {});
}

// ---------- Bridge HTTP 封装 ----------
async function getToken() {
  try {
    const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
    return bridgeToken || "";
  } catch (e) {
    return "";
  }
}

// 返回 { ok, status, data, error? };data 优先 JSON,失败回退为原始文本
async function bridgeFetch(method, path, body) {
  let res;
  try {
    const headers = { "Content-Type": "application/json" };
    const token = await getToken();
    if (token) headers["X-Indify-Token"] = token;
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    res = await fetch(BRIDGE_BASE + path, init);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: "Bridge 不可达:" + (e && e.message || e) };
  }
  const text = await res.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function extractBridgeError(res) {
  if (res && res.error) return res.error;
  if (res && res.data && typeof res.data === "object") {
    return res.data.error || res.data.message || "HTTP " + res.status;
  }
  if (res && typeof res.data === "string") return res.data;
  return "HTTP " + (res && res.status ? res.status : "?");
}

// ---------- adapter 缓存与版本探测(M4) ----------
// 探测策略:content script 同源读 Dify 的 /console/api/app-dsl-version(免登录),
// 得到 app_dsl_version(如 "0.7.0");再从 Bridge 的 /v1/adapters 列表里选
// dslVersion 匹配的 adapter;匹配失败回退到列表第一项(最高版本,即当前部署主版本)。
let adapterListCache = null; // [{version, difyVersion, dslVersion}]

async function getAdapterList() {
  if (adapterListCache) return adapterListCache;
  const res = await bridgeFetch("GET", "/v1/adapters");
  if (res.ok && res.data && Array.isArray(res.data.items)) {
    adapterListCache = res.data.items;
    return adapterListCache;
  }
  return [];
}

async function getAdapter() {
  if (adapterCache) return adapterCache;
  try {
    const { adapter } = await chrome.storage.local.get("adapter");
    if (adapter && adapter.difyVersion) {
      adapterCache = adapter;
      return adapterCache;
    }
  } catch (e) {
    /* 忽略 */
  }

  // 运行时探测:content script 报告 DSL 版本 → 匹配 adapter;
  // 探测失败回退到 adapter 列表第一项(最高版本,即当前部署主版本)。
  let version = null;
  try {
    const dslVersion = await detectDslVersionFromDify();
    const list = await getAdapterList();
    if (list.length === 0) return null;
    if (dslVersion) {
      const hit = list.find((a) => a.dslVersion === dslVersion);
      if (hit) version = hit.version;
    }
    if (!version) version = list[list.length - 1].version; // 列表按版本升序,取最高
  } catch (e) {
    /* 探测失败,走下方兜底 */
  }
  if (!version) return null;

  const res = await bridgeFetch("GET", `/v1/adapter/${version}`);
  if (res.ok && res.data && typeof res.data === "object") {
    adapterCache = res.data;
    chrome.storage.local.set({ adapter: res.data }).catch(() => {});
    return adapterCache;
  }
  return null;
}

/** 让 content script 同源探测 Dify 的 app-dsl-version;失败返回 null。 */
async function detectDslVersionFromDify() {
  if (contextTabId == null) return null;
  try {
    const response = await chrome.tabs.sendMessage(contextTabId, { type: "indify:getDslVersion" });
    if (response && response.ok && response.appDslVersion) {
      return String(response.appDslVersion);
    }
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

// ---------- WebSocket 连接 ----------
async function buildWsUrl() {
  try {
    const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
    if (bridgeToken && typeof bridgeToken === "string" && bridgeToken.length >= 16) {
      return `${BRIDGE_WS_URL}?token=${encodeURIComponent(bridgeToken)}`;
    }
  } catch (e) {
    /* 忽略 */
  }
  return BRIDGE_WS_URL;
}

async function connect() {
  clearReconnectTimer();
  const url = await buildWsUrl();
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.warn("[Indify] 创建 WebSocket 失败:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    lastActivityAt = Date.now();
    bridgeState = { ...bridgeState, connected: true, url };
    startHeartbeat();
    broadcastStatus();
    console.info("[Indify] Bridge 已连接:", url);
  };

  ws.onmessage = (event) => {
    lastActivityAt = Date.now();
    let frame;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch (e) {
      return; // 非 JSON 帧忽略
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "bridge.status") {
      handleBridgeStatus(frame.data);
    } else if (frame.type === "task.frame") {
      handleTaskFrame(frame.data);
    } else if (frame.type === "task.stream") {
      // F3:Agent 实时输出流 → 转给面板逐字渲染(仅增强,断线不补发)
      chrome.runtime
        .sendMessage({ type: "indify:stream", data: frame.data })
        .catch(() => {});
    }
  };

  ws.onerror = () => {
    // onerror 后必触发 onclose,重连由 onclose 处理
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
    try {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    } catch (e) {
      console.warn("[Indify] 心跳发送失败:", e);
    }
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

// ---------- Bridge 帧处理 ----------
function handleBridgeStatus(data) {
  // 仅透传 bridge 连接态;difyVersion/state/note 供面板展示(可选)
  if (data && typeof data === "object") {
    bridgeState = { ...bridgeState, ...data };
  }
  broadcastStatus();
}

function mergeTask(existing, incoming) {
  const inject = existing && existing.inject ? existing.inject : undefined;
  return { ...existing, ...incoming, inject };
}

function handleTaskFrame(data) {
  if (!data || !data.taskId) return;

  if (!currentTask || currentTask.taskId === data.taskId) {
    currentTask = mergeTask(currentTask, data);
  } else {
    // 理论上串行只会有一个任务;防御:收到陌生任务帧则切换
    currentTask = { ...data, inject: { status: "idle" } };
  }

  // U3:任务 done 后拉取任务详情拿 sessionId(201 响应不含 sessionId),供续聊透传
  if (data.status === "done" && currentTask) {
    refreshLastSessionId(currentTask.taskId);
  }

  persistState();
  broadcastTask(currentTask);

  if (data.status === "ready") {
    triggerInject(data.taskId);
  }
}

// 任务 done 后拉取详情,拿到 Bridge 侧实际 sessionId(201 响应不含该字段)
async function refreshLastSessionId(taskId) {
  const res = await bridgeFetch("GET", `/v1/tasks/${taskId}`);
  if (res.ok && res.data && res.data.sessionId) {
    lastSessionId = res.data.sessionId;
    if (currentTask && currentTask.taskId === taskId) {
      currentTask.sessionId = res.data.sessionId;
    }
    persistState();
    broadcastTask(currentTask);
  }
}

// ---------- 注入编排 ----------
const injecting = new Set();

function setInjectStatus(taskId, inject) {
  if (!currentTask || currentTask.taskId !== taskId) return;
  currentTask.inject = { ...(currentTask.inject || {}), ...inject };
  persistState();
  broadcastTask(currentTask);
}

function triggerInject(taskId) {
  if (injecting.has(taskId) || injectedTaskIds.has(taskId)) return; // 幂等
  injecting.add(taskId);
  const task = currentTask;
  const worker =
    task && task.mode === "modify" ? doInjectModify(taskId) : doInject(taskId);
  worker
    .then((didInject) => {
      // didInject === false 表示未真正注入(如 needDify),不标记,允许后续重试
      if (didInject) {
        injectedTaskIds.add(taskId);
        persistState();
      }
    })
    .catch((e) => {
      setInjectStatus(taskId, { status: "failed", error: String((e && e.message) || e) });
    })
    .finally(() => {
      injecting.delete(taskId);
    });
}

// create:拉 workflow.yaml → injectCreate → injected → 打开新应用页。返回 true 表示已注入
async function doInject(taskId) {
  if (contextTabId == null) {
    setInjectStatus(taskId, { status: "needDify" });
    return false;
  }

  const adapter = await getAdapter();
  if (!adapter) throw new Error("无法获取 adapter(请确认 Bridge 的 /v1/adapters 与 /v1/adapter/{version} 可用)");

  const yamlRes = await bridgeFetch("GET", `/v1/artifacts/${taskId}/workflow.yaml`);
  if (!yamlRes.ok) {
    throw new Error(`获取 workflow.yaml 失败(HTTP ${yamlRes.status})`);
  }
  const yamlText = typeof yamlRes.data === "string" ? yamlRes.data : JSON.stringify(yamlRes.data);

  setInjectStatus(taskId, { status: "injecting" });

  let injectResult;
  try {
    injectResult = await chrome.tabs.sendMessage(contextTabId, {
      type: "indify:injectCreate",
      yamlText,
      adapter,
    });
  } catch (e) {
    throw new Error("content script 注入失败(确认 Dify 页面已打开):" + ((e && e.message) || e));
  }

  if (!injectResult || injectResult.ok !== true) {
    // 逃生舱(route B 失败):把状态标为 importFailed,面板提供「复制 YAML」+ 手动导入指引
    const reason = (injectResult && injectResult.error) || "导入失败(未知错误)";
    setInjectStatus(taskId, { status: "importFailed", error: reason });
    return false;
  }

  const appId = injectResult.appId;
  const pattern = adapter.urls && adapter.urls.workflowPagePattern;
  const appUrl = pattern ? pattern.replace("{app_id}", appId || "") : undefined;

  await bridgeFetch("POST", `/v1/tasks/${taskId}/injected`, { appId, appUrl });

  if (appUrl && contextTabId != null) {
    chrome.tabs.update(contextTabId, { url: appUrl }).catch(() => {});
  }

  setInjectStatus(taskId, { status: "done", appId, appUrl });
  return true;
}

// modify:拉 graph.json → injectModify(读最新 hash 再写回)→ injected → 单次刷新。返回 true 表示已注入
async function doInjectModify(taskId) {
  const task = currentTask;
  const appId = task && task.context && task.context.appId;
  const appUrl = task && task.context && task.context.appUrl;

  if (contextTabId == null) {
    setInjectStatus(taskId, { status: "needDify" });
    return false;
  }
  if (!appId) {
    setInjectStatus(taskId, { status: "needDify", error: "缺少 appId(请回到工作流画布页)" });
    return false;
  }

  const adapter = await getAdapter();
  if (!adapter) throw new Error("无法获取 adapter");

  const graphRes = await bridgeFetch("GET", `/v1/artifacts/${taskId}/graph.json`);
  if (!graphRes.ok) {
    throw new Error(`获取 graph.json 失败(HTTP ${graphRes.status})`);
  }
  const graphText = typeof graphRes.data === "string" ? graphRes.data : JSON.stringify(graphRes.data);

  setInjectStatus(taskId, { status: "injecting" });

  let result;
  try {
    result = await chrome.tabs.sendMessage(contextTabId, {
      type: "indify:injectModify",
      appId,
      graphText,
      adapter,
    });
  } catch (e) {
    throw new Error("content script 写回失败(确认 Dify 页面已打开):" + ((e && e.message) || e));
  }

  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || "写回失败(未知错误)");
  }

  await bridgeFetch("POST", `/v1/tasks/${taskId}/injected`, { appId, appUrl });

  // 唯一一次刷新:画布就地呈现(不在 content script 里 reload,由 SW 统一控制)
  if (contextTabId != null) {
    chrome.tabs.reload(contextTabId).catch(() => {});
  }

  setInjectStatus(taskId, { status: "done", appId, appUrl });
  return true;
}

// ---------- content script 上下文刷新 ----------
async function requestContextFromContent(messageType) {
  if (contextTabId == null) return false;
  try {
    const response = await chrome.tabs.sendMessage(contextTabId, { type: messageType });
    if (response && response.context) {
      context = { ...response.context };
      broadcastStatus();
      return true;
    }
  } catch (e) {
    // 标签页已关闭或 content script 未注入
  }
  return false;
}

function startContextRefresh() {
  if (contextRefreshTimer) return;
  contextRefreshTimer = setInterval(() => {
    requestContextFromContent("indify:ping");
  }, CONTEXT_REFRESH_INTERVAL_MS);
}

// ---------- 任务消息处理(返回 Promise 作为 sendResponse) ----------
async function submitTask(message) {
  const spec = (message.spec || "").trim();
  if (!spec) return { ok: false, error: "需求不能为空" };
  const mode = message.mode || "create";

  const body = { mode, spec };
  if (lastSessionId) body.sessionId = lastSessionId; // U3 会话透传

  if (mode === "modify") {
    // 刷新上下文拿最新 appId(避免用户已切换页面)
    await requestContextFromContent("indify:getContext");
    if (contextTabId == null || !context || !context.appId) {
      return { ok: false, error: "请先打开 Dify 工作流画布页(http://localhost/app/{uuid}/workflow)", needDify: true };
    }
    const adapter = await getAdapter();
    if (!adapter) return { ok: false, error: "无法获取 adapter" };

    let draftRes;
    try {
      draftRes = await chrome.tabs.sendMessage(contextTabId, {
        type: "indify:getDraft",
        appId: context.appId,
        adapter,
      });
    } catch (e) {
      return { ok: false, error: "读取草稿失败(确认 Dify 页面已打开):" + ((e && e.message) || e), needDify: true };
    }
    if (!draftRes || draftRes.ok !== true) {
      return { ok: false, error: (draftRes && draftRes.error) || "读取草稿失败" };
    }

    const appUrl = (adapter.urls && adapter.urls.workflowPagePattern)
      ? adapter.urls.workflowPagePattern.replace("{app_id}", context.appId)
      : context.url;
    body.context = {
      appId: context.appId,
      appUrl,
      currentGraph: (draftRes.draft && draftRes.draft.graph) || null,
    };
  } else {
    if (context && context.appId) body.context = { appId: context.appId };
  }

  const res = await bridgeFetch("POST", "/v1/tasks", body);
  if (!res.ok) return { ok: false, error: extractBridgeError(res) };

  const data = res.data || {};
  currentTask = {
    taskId: data.taskId,
    status: data.status || "queued",
    mode,
    spec,
    sessionId: data.sessionId || lastSessionId || null,
    context: body.context || null,
    inject: { status: "idle" },
  };
  persistState();
  broadcastTask(currentTask);
  return { ok: true, taskId: data.taskId, status: data.status };
}

async function sendDecision(message) {
  const { taskId, action, feedback, planText } = message;
  if (!taskId || !action) return { ok: false, error: "缺少 taskId 或 action" };
  const body = { action };
  if (feedback !== undefined) body.feedback = feedback;
  if (planText !== undefined) body.planText = planText; // build:用户最终计划文本(唯一权威)
  const res = await bridgeFetch("POST", `/v1/tasks/${taskId}/decision`, body);
  if (!res.ok) return { ok: false, error: extractBridgeError(res) };
  return { ok: true };
}

async function getArtifact(message) {
  const { taskId, file } = message;
  if (!taskId || !file) return { ok: false, error: "缺少 taskId 或 file" };
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return { ok: false, error: "非法文件名" };
  const res = await bridgeFetch("GET", `/v1/artifacts/${taskId}/${file}`);
  if (!res.ok) {
    return { ok: false, status: res.status, error: `产物不存在或获取失败(HTTP ${res.status})` };
  }
  return { ok: true, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
}

async function getAdapterForPanel() {
  const adapter = await getAdapter();
  if (!adapter) return { ok: false, error: "无法获取 adapter" };
  return { ok: true, adapter };
}

async function retryInject(message) {
  const { taskId } = message;
  if (!taskId) return { ok: false, error: "缺少 taskId" };
  if (injectedTaskIds.has(taskId)) {
    return { ok: true, note: "该任务已注入过" };
  }
  if (currentTask && currentTask.taskId === taskId) {
    currentTask.inject = { status: "idle" };
    broadcastTask(currentTask);
  }
  triggerInject(taskId);
  return { ok: true };
}

async function newSession() {
  lastSessionId = null;
  persistState();
  return { ok: true };
}

// ---------- 消息路由 ----------
function handleContext(message, sender) {
  context = { ...(message.context || {}) };
  if (sender.tab && sender.tab.id != null) contextTabId = sender.tab.id;
  broadcastStatus();
}

async function handleGetStatus() {
  broadcastStatus();
  if (currentTask) broadcastTask(currentTask);
  requestContextFromContent("indify:getContext"); // fire-and-forget 刷新
  return {
    bridge: { ...bridgeState },
    context: { ...context },
    task: currentTask ? { ...currentTask } : null,
    lastSessionId: lastSessionId,
  };
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "indify:context":
      handleContext(message, sender);
      return;

    case "indify:getStatus":
      return handleGetStatus();

    case "indify:submitTask":
      return submitTask(message);

    case "indify:decision":
      return sendDecision(message);

    case "indify:getArtifact":
      return getArtifact(message);

    case "indify:getAdapter":
      return getAdapterForPanel();

    case "indify:retryInject":
      return retryInject(message);

    case "indify:newSession":
      return newSession();

    default:
      return;
  }
});

// ---------- 标签页生命周期 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === contextTabId) {
    contextTabId = null;
  }
});

// ---------- token 变更 → 立即重连 ----------
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
  broadcastStatus();
  if (currentTask) broadcastTask(currentTask);
  connect();
  startContextRefresh();
})();
