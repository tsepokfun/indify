// Indify side panel — M3(新建 U1 + 就地修改 U2 + 续聊 U3)
// 从 SW 拉状态 / 订阅 onMessage 渲染;无外部依赖,纯 JS。
// 关键渲染逻辑抽为纯函数(见下),便于静态自查。

// ================= 纯函数(可独立自查) =================

function statusLabel(status) {
  const map = {
    queued: "排队中",
    "agent-running": "Agent 生成中",
    "draft-ready": "等待确认",
    finalizing: "生成终稿中",
    ready: "已就绪",
    injecting: "注入画布中",
    done: "完成",
    failed: "失败",
  };
  return map[status] || status || "未知状态";
}

function statusProgress(status) {
  const map = {
    queued: 10,
    "agent-running": 35,
    "draft-ready": 55,
    finalizing: 70,
    ready: 85,
    injecting: 92,
    done: 100,
    failed: 100,
  };
  return map[status] != null ? map[status] : 0;
}

function statusClass(status) {
  if (status === "done") return "s-done";
  if (status === "failed") return "s-failed";
  if (status === "draft-ready") return "s-wait";
  return "s-running";
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 结构预览卡片:data = { name, mode, nodes:[], edges:[] }(create 来自 ir,modify 来自 graph)
function buildPreviewCard(data, summary) {
  if (!data) {
    return `<div class="preview"><div class="p-loading">正在加载预览…</div></div>`;
  }
  const name = data.name || "(未命名)";
  const mode = data.mode || "workflow";
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const nodeItems = nodes
    .map((n) => `<li>${escapeHtml(n.type)} · ${escapeHtml(n.title || n.id)}</li>`)
    .join("");
  const summaryHtml = summary
    ? `<div class="task-summary">${escapeHtml(summary)}</div>`
    : "";
  return `
    <div class="preview">
      <div class="p-title">${escapeHtml(name)}</div>
      <div class="p-meta">模式:${escapeHtml(mode)} · 节点 ${nodes.length} 个 · 连边 ${edges.length} 条</div>
      ${summaryHtml}
      <div class="p-nodes">
        <strong>节点清单:</strong>
        <ul>${nodeItems || "<li>(无节点)</li>"}</ul>
      </div>
    </div>`;
}

// 任务卡片:task = { taskId, status, mode, summary?, error?, spec?, sessionId?, inject? },preview = { data, summary }
function buildTaskCard(task, preview) {
  const status = task.status || "queued";
  const isModify = task.mode === "modify";
  // modify 的 injecting 文案 = "写回画布中…"
  const label =
    status === "injecting" && isModify ? "写回画布中…" : statusLabel(status);
  const cls = statusClass(status);
  const pct = statusProgress(status);
  const barCls = status === "done" ? "bar-done" : status === "failed" ? "bar-failed" : "";

  let body = "";

  if (status === "failed") {
    const err = task.error || (task.inject && task.inject.error) || "任务失败";
    body += `<div class="task-error">${escapeHtml(err)}</div>`;
  } else if (task.summary && !["draft-ready", "ready", "done"].includes(status)) {
    body += `<div class="task-summary">${escapeHtml(task.summary)}</div>`;
  }

  if (status === "draft-ready") {
    body += buildPreviewCard(preview && preview.data, preview && preview.summary);
    if (preview && preview.data) {
      body += `
        <div class="btn-row">
          <button class="btn primary" data-action="approve">确认</button>
          <button class="btn" data-action="toggle-revise">提出修改</button>
        </div>
        <div class="revise-box">
          <textarea id="revise-input" placeholder="描述需要修改的地方…"></textarea>
          <div class="btn-row">
            <button class="btn primary" data-action="submit-revise">提交修改</button>
            <button class="btn" data-action="cancel-revise">取消</button>
          </div>
        </div>`;
    }
  }

  if (status === "ready") {
    const inj = task.inject || {};
    if (inj.status === "needDify") {
      body += `<div class="task-summary">已生成工作流,但未检测到 Dify 页面。请先打开 http://localhost 的 Dify 控制台。</div>
        <div class="btn-row"><button class="btn primary" data-action="retry-inject">重试注入</button></div>`;
    } else if (inj.status === "failed") {
      body += `<div class="task-error">注入失败:${escapeHtml(inj.error || "")}</div>
        <div class="btn-row"><button class="btn" data-action="retry-inject">重试注入</button></div>`;
    } else if (inj.status === "importFailed") {
      // 逃生舱:route B 导入失败 → 复制 YAML 手动导入(永远可用的降级,§8.1 第 4 步)
      body += `<div class="task-error">自动导入失败:${escapeHtml(inj.error || "")}</div>
        <div class="task-summary">逃生舱:复制 YAML 后在 Dify「应用列表 → 导入 DSL 文件」里手动导入。</div>
        <div class="btn-row">
          <button class="btn primary" data-action="copy-yaml">复制 YAML 到剪贴板</button>
          <button class="btn" data-action="retry-inject">重试自动导入</button>
        </div>`;
    } else {
      body += `<div class="task-summary">${isModify ? "已生成,写回画布中…" : "已生成,注入画布中…"}</div>`;
    }
  }

  if (status === "done") {
    const inj = task.inject || {};
    const url = inj.appUrl;
    const msg = isModify ? "画布已更新(已刷新)" : task.summary || "已注入完成,请查看画布。";
    body += `<div class="task-summary">${escapeHtml(msg)}</div>`;
    if (!isModify && url) {
      body += `<div class="result-link"><a data-action="open-app" data-url="${escapeHtml(url)}">打开工作流画布 →</a></div>`;
    }
    if (task.sessionId) {
      body += `
        <div class="session-row">
          <span>继续修改(同一会话)</span>
          <button class="btn" data-action="new-session">新会话</button>
        </div>`;
    }
  }

  if (status === "failed") {
    body += `<div class="btn-row"><button class="btn primary" data-action="retry">重试</button></div>`;
  }

  return `
    <div class="card">
      <div class="task-status"><span class="${cls}">${escapeHtml(label)}</span></div>
      <div class="progress"><div class="bar ${barCls}" style="width:${pct}%"></div></div>
      ${body}
    </div>`;
}

// ================= DOM 与状态 =================

const els = {
  bridgeDot: document.getElementById("bridge-dot"),
  bridgeText: document.getElementById("bridge-text"),
  contextText: document.getElementById("context-text"),
  tokenBox: document.getElementById("token-box"),
  tokenInput: document.getElementById("token-input"),
  tokenSave: document.getElementById("token-save"),
  messages: document.getElementById("messages"),
  userMessages: document.getElementById("user-messages"),
  taskCard: document.getElementById("task-card"),
  emptyHint: document.getElementById("empty-hint"),
  chatInput: document.getElementById("chat-input"),
  sendBtn: document.getElementById("send-btn"),
  modeHint: document.getElementById("mode-hint"),
};

let state = {
  messages: [], // { role:"user"|"system", text, ts }
  currentTask: null,
  context: {}, // 最近一次 indify:status 携带的 Dify 页上下文
};

let preview = null; // { taskId, data, summary }
let previewLoadingTaskId = null;

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
    els.tokenBox.classList.add("show");
  }
  els.bridgeText.title = bridge.url || "";
  els.contextText.textContent = formatContext(ctx);

  if (ctx && ctx.url) state.context = ctx;
  renderModeHint();
}

function isWorkflowPage() {
  return !!(state.context && state.context.page === "workflow" && state.context.appId);
}

function renderModeHint() {
  els.modeHint.textContent = isWorkflowPage() ? "将修改当前工作流" : "将新建工作流";
}

function renderUserMessages() {
  els.userMessages.innerHTML = state.messages
    .map((m) => {
      const bubble = escapeHtml(m.text);
      if (m.role === "user") {
        return `<div class="msg user"><div class="bubble">${bubble}</div></div>`;
      }
      return `<div class="msg system"><div class="bubble">${bubble}</div></div>`;
    })
    .join("");
}

function renderTaskCard() {
  const t = state.currentTask;
  if (!t) {
    els.taskCard.innerHTML = "";
    els.taskCard.style.display = "none";
    return;
  }
  els.taskCard.style.display = "block";
  const p = preview && preview.taskId === t.taskId ? preview : null;
  els.taskCard.innerHTML = buildTaskCard(t, p);
}

function render() {
  renderUserMessages();
  renderTaskCard();
  els.emptyHint.style.display =
    state.messages.length === 0 && !state.currentTask ? "block" : "none";
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ================= 持久化 =================
async function persistPanelState() {
  try {
    await chrome.storage.session.set({
      messages: state.messages,
      currentTask: state.currentTask,
    });
  } catch (e) {
    console.warn("[Indify] 面板状态保存失败:", e);
  }
}

// ================= 消息收发 =================
function sendMessagePromise(msg) {
  return chrome.runtime
    .sendMessage(msg)
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function pushUserMessage(text) {
  state.messages.push({ role: "user", text, ts: Date.now() });
  persistPanelState();
  render();
}

function pushSystemMessage(text) {
  state.messages.push({ role: "system", text, ts: Date.now() });
  persistPanelState();
  render();
}

// ================= 预览加载 =================
function maybeLoadPreview(taskId) {
  if (!taskId) return;
  if (preview && preview.taskId === taskId) return;
  loadPreview(taskId);
}

async function loadPreview(taskId) {
  if (previewLoadingTaskId === taskId) return;
  previewLoadingTaskId = taskId;
  preview = { taskId, data: null, summary: null };
  renderTaskCard();

  const task = state.currentTask;
  const isModify = task && task.mode === "modify";
  const dataFile = isModify ? "graph.json" : "ir.json";

  const dataRes = await sendMessagePromise({ type: "indify:getArtifact", taskId, file: dataFile });
  const resultRes = await sendMessagePromise({ type: "indify:getArtifact", taskId, file: "result.json" });

  let raw = null;
  let summary = null;
  if (dataRes.ok) {
    try { raw = JSON.parse(dataRes.text); } catch (e) { /* ignore */ }
  }
  if (resultRes.ok) {
    try {
      const r = JSON.parse(resultRes.text);
      summary = r && r.summary;
    } catch (e) { /* ignore */ }
  }

  // 归一化为 buildPreviewCard 需要的形状
  const data = isModify
    ? {
        name: "当前工作流(就地修改)",
        mode: "workflow",
        nodes: (raw && raw.nodes) || [],
        edges: (raw && raw.edges) || [],
      }
    : {
        name: raw && raw.meta && raw.meta.name,
        mode: (raw && raw.meta && raw.meta.mode) || "workflow",
        nodes: (raw && raw.nodes) || [],
        edges: (raw && raw.edges) || [],
      };

  preview = { taskId, data, summary };
  previewLoadingTaskId = null;
  renderTaskCard();
}

// ================= 任务动作 =================
async function submit() {
  const spec = els.chatInput.value.trim();
  if (!spec) return;
  els.chatInput.value = "";
  els.sendBtn.disabled = true;
  pushUserMessage(spec);

  const mode = isWorkflowPage() ? "modify" : "create";
  const res = await sendMessagePromise({ type: "indify:submitTask", mode, spec });

  els.sendBtn.disabled = false;
  els.chatInput.focus();
  if (!res.ok) {
    pushSystemMessage("提交失败:" + (res.error || "未知错误"));
  }
  // 成功:SW 会广播 indify:task(queued)
}

async function doDecision(taskId, action, feedback) {
  const res = await sendMessagePromise({ type: "indify:decision", taskId, action, feedback });
  if (!res.ok) {
    pushSystemMessage("操作失败:" + (res.error || "未知错误"));
  }
}

async function retrySubmit(task) {
  if (!task || !task.spec) return;
  pushSystemMessage("已重试:重新提交任务…");
  const res = await sendMessagePromise({ type: "indify:submitTask", mode: task.mode || "create", spec: task.spec });
  if (!res.ok) {
    pushSystemMessage("重试提交失败:" + (res.error || "未知错误"));
  }
}

async function doRetryInject(taskId) {
  const res = await sendMessagePromise({ type: "indify:retryInject", taskId });
  if (!res.ok) {
    pushSystemMessage("重试注入失败:" + (res.error || "未知错误"));
  }
}

// 逃生舱:从 Bridge 拉 workflow.yaml → 写入剪贴板,提示用户手动导入
async function doCopyYaml(taskId) {
  try {
    const res = await sendMessagePromise({ type: "indify:getArtifact", taskId, file: "workflow.yaml" });
    const text = res && res.ok ? res.text : null;
    if (!text) {
      pushSystemMessage("获取 workflow.yaml 失败:" + ((res && res.error) || "未知错误"));
      return;
    }
    await navigator.clipboard.writeText(text);
    pushSystemMessage("✅ YAML 已复制到剪贴板。请在 Dify「应用列表 → 导入 DSL 文件」里粘贴保存后手动导入。");
  } catch (e) {
    pushSystemMessage("复制失败:" + String((e && e.message) || e));
  }
}

async function doNewSession() {
  const res = await sendMessagePromise({ type: "indify:newSession" });
  if (!res.ok) {
    pushSystemMessage("开启新会话失败:" + (res.error || "未知错误"));
    return;
  }
  if (state.currentTask) state.currentTask.sessionId = null;
  persistPanelState();
  pushSystemMessage("已开启新会话(下次提交不复用原会话)");
}

// ================= 事件绑定 =================
els.sendBtn.addEventListener("click", submit);
els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

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

// 任务卡片按钮委托(容器不变,innerHTML 重绘后无需重绑)
els.taskCard.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const task = state.currentTask;
  if (!task) return;

  switch (action) {
    case "approve":
      doDecision(task.taskId, "approve");
      break;
    case "toggle-revise": {
      const box = els.taskCard.querySelector(".revise-box");
      if (box) box.classList.toggle("show");
      break;
    }
    case "cancel-revise": {
      const box = els.taskCard.querySelector(".revise-box");
      if (box) box.classList.remove("show");
      const ta = els.taskCard.querySelector("#revise-input");
      if (ta) ta.value = "";
      break;
    }
    case "submit-revise": {
      const ta = els.taskCard.querySelector("#revise-input");
      const feedback = ta ? ta.value.trim() : "";
      if (!feedback) return;
      doDecision(task.taskId, "revise", feedback);
      break;
    }
    case "retry":
      retrySubmit(task);
      break;
    case "retry-inject":
      doRetryInject(task.taskId);
      break;
    case "copy-yaml":
      doCopyYaml(task.taskId);
      break;
    case "open-app": {
      const url = btn.dataset.url;
      if (url) chrome.tabs.create({ url });
      break;
    }
    case "new-session":
      doNewSession();
      break;
    default:
      break;
  }
});

// ================= 消息订阅 =================
function onTaskMessage(task) {
  if (!task) return;
  state.currentTask = task;
  persistPanelState();
  if (task.status === "draft-ready") {
    maybeLoadPreview(task.taskId);
  }
  render();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "indify:status") {
    renderStatus(message);
  } else if (message.type === "indify:task") {
    onTaskMessage(message.task);
  }
});

// ================= 启动 =================
async function init() {
  // 1) 恢复 storage.session(面板重开可恢复最后一次任务视图)
  try {
    const data = await chrome.storage.session.get(["messages", "currentTask", "bridge", "context"]);
    if (Array.isArray(data.messages)) state.messages = data.messages;
    if (data.currentTask) state.currentTask = data.currentTask;
    renderStatus({ bridge: data.bridge || {}, context: data.context || {} });
    render();
    if (state.currentTask && state.currentTask.status === "draft-ready") {
      maybeLoadPreview(state.currentTask.taskId);
    }
  } catch (e) {
    console.warn("[Indify] 恢复状态失败:", e);
  }

  // 2) 请求 SW 最新状态(触发广播 + 直接响应)
  try {
    const res = await chrome.runtime.sendMessage({ type: "indify:getStatus" });
    if (res && res.bridge) renderStatus(res);
    if (res && res.task) {
      state.currentTask = res.task;
      persistPanelState();
      render();
      if (state.currentTask.status === "draft-ready") {
        maybeLoadPreview(state.currentTask.taskId);
      }
    }
  } catch (e) {
    /* 忽略 */
  }
}

init();
