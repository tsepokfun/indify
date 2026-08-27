// Indify side panel — v2(M3 基础 + 两段式确认 F2)
// 从 SW 拉状态 / 订阅 onMessage 渲染;无外部依赖,纯 JS。
// 关键渲染逻辑抽为纯函数(见下),便于静态自查。

// ================= 纯函数(可独立自查) =================

function statusLabel(status) {
  const map = {
    queued: "排队中",
    planning: "制定计划中",
    "plan-ready": "等待确认计划",
    building: "构建中",
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
    queued: 8,
    planning: 25,
    "plan-ready": 45,
    building: 55,
    "agent-running": 60,
    "draft-ready": 68,
    finalizing: 78,
    ready: 88,
    injecting: 94,
    done: 100,
    failed: 100,
  };
  return map[status] != null ? map[status] : 0;
}

function statusClass(status) {
  if (status === "done") return "s-done";
  if (status === "failed") return "s-failed";
  if (status === "plan-ready" || status === "draft-ready") return "s-wait";
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

// 计划文本框(可编辑,对话中部;planEdit = 用户手改版本,优先级高于服务器版 planText)
function buildPlanBox(planText, planEdit, summary) {
  const text = planEdit != null ? planEdit : planText || "";
  const summaryHtml = summary ? `<div class="task-summary">${escapeHtml(summary)}</div>` : "";
  return `
    <div class="plan-box">
      <div class="plan-hint">实施计划(可直接编辑)。手改后点「开始构建」即以当前文本为准;
        或点「让 Agent 修订」附补充说明让 Agent 重写。</div>
      ${summaryHtml}
      <textarea id="plan-input" spellcheck="false">${escapeHtml(text)}</textarea>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn primary" data-action="build"${decisionBusy ? " disabled" : ""}>开始构建 Build</button>
        <button class="btn" data-action="toggle-plan-revise">让 Agent 修订</button>
        <button class="btn" data-action="add-attach-plan" title="补传附件(PDF/图片/文本)">📎 补传附件</button>
      </div>
      <div class="revise-box">
        <textarea id="plan-revise-note" placeholder="补充说明(可选;将连同上方计划全文一起发给 Agent)…"></textarea>
        <div class="btn-row">
          <button class="btn primary" data-action="submit-plan-revise"${decisionBusy ? " disabled" : ""}>提交修订</button>
          <button class="btn" data-action="cancel-plan-revise">取消</button>
        </div>
      </div>
    </div>`;
}

// Agent 实时输出(F3):segs = [{kind:"text"|"reasoning"|"tool"|"hint", text}]
const TURNING_STATUSES = new Set(["planning", "building", "agent-running", "finalizing"]);

function streamSegmentsHtml(segs) {
  return (segs || [])
    .map((s) => {
      if (s.kind === "tool") {
        return `<div class="ao-tool">🔧 执行工具中…${s.text ? " " + escapeHtml(s.text) : ""}</div>`;
      }
      if (s.kind === "hint") {
        return `<div class="ao-hint">${escapeHtml(s.text)}</div>`;
      }
      if (s.kind === "reasoning") {
        return `<span class="ao-think">${escapeHtml(s.text)}</span>`;
      }
      return `<span>${escapeHtml(s.text)}</span>`;
    })
    .join("");
}

// 任务卡片:task = { taskId, status, mode, summary?, error?, spec?, sessionId?, inject? },preview,plan,stream
function buildTaskCard(task, preview, plan, stream) {
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
  } else if (
    task.summary &&
    !["plan-ready", "draft-ready", "ready", "done"].includes(status)
  ) {
    body += `<div class="task-summary">${escapeHtml(task.summary)}</div>`;
  }

  // F3:turn 进行中的状态渲染「Agent 输出」滚动区(逐字流式,60s 无输出有提示)
  if (TURNING_STATUSES.has(status)) {
    body += `<div class="agent-output" id="agent-output">${streamSegmentsHtml(
      stream && stream.segs
    )}</div>`;
  }

  if (status === "plan-ready") {
    body += buildPlanBox(plan && plan.text, plan && plan.edit, task.summary);
  }

  if (status === "draft-ready") {
    body += buildPreviewCard(preview && preview.data, preview && preview.summary);
    if (preview && preview.data) {
      body += `
        <div class="btn-row">
          <button class="btn primary" data-action="approve"${decisionBusy ? " disabled" : ""}>确认</button>
          <button class="btn" data-action="toggle-revise">提出修改</button>
        </div>
        <div class="revise-box">
          <textarea id="revise-input" placeholder="描述需要修改的地方…"></textarea>
          <div class="btn-row">
            <button class="btn primary" data-action="submit-revise"${decisionBusy ? " disabled" : ""}>提交修改</button>
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
  attachBtn: document.getElementById("attach-btn"),
  attachInput: document.getElementById("attach-input"),
  attachRow: document.getElementById("attach-row"),
  planAttachInput: document.getElementById("plan-attach-input"),
};

let state = {
  messages: [], // { role:"user"|"system", text, ts }
  currentTask: null,
  context: {}, // 最近一次 indify:status 携带的 Dify 页上下文
};

let pendingAttachments = []; // 待发送附件 {name, mimeType, size, dataBase64}

let preview = null; // { taskId, data, summary }
let previewLoadingTaskId = null;
let plan = null; // { taskId, text, edit }  text=服务器 plan.txt,edit=用户手改(优先)

// F3 流式状态:只跟踪当前任务的一个流缓冲
let stream = null; // { taskId, segs: [{kind, text}] }
let streamIdleTimer = null;
const STREAM_IDLE_HINT_MS = 60000; // 60s 无新输出 → 提示(计划 §3)

function disarmStreamIdle() {
  if (streamIdleTimer) {
    clearTimeout(streamIdleTimer);
    streamIdleTimer = null;
  }
}

function armStreamIdle() {
  disarmStreamIdle();
  streamIdleTimer = setTimeout(() => {
    const t = state.currentTask;
    if (!t || !stream || stream.taskId !== t.taskId) return;
    if (!TURNING_STATUSES.has(t.status)) return;
    const seg = { kind: "hint", text: "… Agent 仍在工作(60 秒无新输出)" };
    stream.segs.push(seg);
    appendStreamSegment(seg);
  }, STREAM_IDLE_HINT_MS);
}

function clearStream() {
  disarmStreamIdle();
  stream = null;
}

// 直接把一个流片段追加进当前卡片的输出区(不整体重绘,保护计划文本框的手改内容)
function appendStreamSegment(seg) {
  const box = els.taskCard.querySelector("#agent-output");
  if (!box) return;
  let el;
  if (seg.kind === "tool") {
    el = document.createElement("div");
    el.className = "ao-tool";
    el.textContent = "🔧 执行工具中…" + (seg.text ? " " + seg.text : "");
  } else if (seg.kind === "hint") {
    el = document.createElement("div");
    el.className = "ao-hint";
    el.textContent = seg.text;
  } else if (seg.kind === "reasoning") {
    el = document.createElement("span");
    el.className = "ao-think";
    el.textContent = seg.text;
  } else {
    el = document.createElement("span");
    el.textContent = seg.text;
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  els.messages.scrollTop = els.messages.scrollHeight;
}

function onStream(data) {
  const t = state.currentTask;
  if (!t || !data || data.taskId !== t.taskId) return; // 防串台:只看当前任务
  if (!TURNING_STATUSES.has(t.status)) return; // turn 已结束的迟到帧忽略
  if (!stream || stream.taskId !== t.taskId) {
    stream = { taskId: t.taskId, segs: [] };
  }
  if (typeof data.delta === "string" && data.delta.length > 0) {
    const seg = { kind: data.kind === "reasoning" ? "reasoning" : "text", text: data.delta };
    stream.segs.push(seg);
    appendStreamSegment(seg);
    armStreamIdle();
  } else if (typeof data.tool === "string") {
    const seg = { kind: "tool", text: data.tool };
    stream.segs.push(seg);
    appendStreamSegment(seg);
    armStreamIdle();
  }
}

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
  const pl = plan && plan.taskId === t.taskId ? plan : null;
  const st = stream && stream.taskId === t.taskId ? stream : null;
  els.taskCard.innerHTML = buildTaskCard(t, p, pl, st);
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

// ================= 计划加载(plan-ready 阶段) =================
async function loadPlan(taskId) {
  const res = await sendMessagePromise({ type: "indify:getArtifact", taskId, file: "plan.txt" });
  const text = res && res.ok ? res.text : null;
  if (state.currentTask && state.currentTask.taskId === taskId) {
    plan = { taskId, text: text || "", edit: null };
    renderTaskCard();
  }
}

// ================= 预览加载(draft-ready 阶段) =================
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

// ================= 附件(F1:前端白名单校验;Bridge 为权威校验) =================
const ATTACH_LIMITS = {
  pdf: 20 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  text: 5 * 1024 * 1024,
  maxImages: 20,
};
const ATTACH_EXTS = {
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "webp", "gif"],
  text: ["txt", "md", "csv", "json", "yaml", "yml"],
};

function attachKind(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  for (const [kind, exts] of Object.entries(ATTACH_EXTS)) {
    if (exts.includes(ext)) return kind;
  }
  return null;
}

function validateAttachFront(file, extraImages) {
  const kind = attachKind(file.name);
  if (!kind) {
    return { ok: false, error: `「${file.name}」暂不支持(仅 PDF/图片/文本;音视频与 docx 等请转为 PDF 或文本)` };
  }
  const cap = ATTACH_LIMITS[kind];
  if (file.size > cap) {
    return { ok: false, error: `「${file.name}」超出大小上限(${Math.round(cap / 1024 / 1024)}MB/个)` };
  }
  if (kind === "image" && extraImages >= ATTACH_LIMITS.maxImages) {
    return { ok: false, error: `图片数量超过上限(≤${ATTACH_LIMITS.maxImages} 张/任务)` };
  }
  return { ok: true, kind };
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const dataBase64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
      resolve({ name: file.name, mimeType: file.type || "", size: file.size, dataBase64 });
    };
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.readAsDataURL(file);
  });
}

function currentImageCount() {
  return pendingAttachments.filter((a) => attachKind(a.name) === "image").length;
}

function renderChips() {
  els.attachRow.innerHTML = pendingAttachments
    .map(
      (a, i) => `<span class="chip"><span class="chip-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>` +
        `<span class="chip-size">${(a.size / 1024).toFixed(0)}KB</span>` +
        `<span class="chip-x" data-action="remove-attach" data-idx="${i}">×</span></span>`
    )
    .join("");
}

async function handleAttachFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;
  let images = currentImageCount();
  const accepted = [];
  for (const f of list) {
    const check = validateAttachFront(f, images);
    if (!check.ok) {
      pushSystemMessage("附件被拒:" + check.error);
      continue;
    }
    if (check.kind === "image") images += 1;
    accepted.push(f);
  }
  for (const f of accepted) {
    try {
      pendingAttachments.push(await fileToAttachment(f));
    } catch (e) {
      pushSystemMessage(String((e && e.message) || e));
    }
  }
  renderChips();
}

// 计划阶段补传附件(plan-ready 时可用;发送后由 Bridge 追加到任务目录)
async function handlePlanAttachFiles(files) {
  const t = state.currentTask;
  if (!t) return;
  const list = Array.from(files || []);
  if (list.length === 0) return;
  let images = 0;
  const accepted = [];
  for (const f of list) {
    const check = validateAttachFront(f, images);
    if (!check.ok) {
      pushSystemMessage("附件被拒:" + check.error);
      continue;
    }
    if (check.kind === "image") images += 1;
    accepted.push(f);
  }
  const attachments = [];
  for (const f of accepted) {
    try {
      attachments.push(await fileToAttachment(f));
    } catch (e) {
      pushSystemMessage(String((e && e.message) || e));
    }
  }
  if (attachments.length === 0) return;
  const res = await sendMessagePromise({ type: "indify:addAttachments", taskId: t.taskId, attachments });
  if (res && res.ok) {
    pushSystemMessage(`✅ 已补传 ${attachments.length} 个附件(Agent 将在下一轮计划修订/构建时读取)`);
  } else {
    pushSystemMessage("补传失败:" + ((res && res.error) || "未知错误"));
  }
  els.planAttachInput.value = "";
}

// ================= 任务动作 =================
async function submit() {
  const spec = els.chatInput.value.trim();
  if (!spec) return;
  els.chatInput.value = "";
  els.sendBtn.disabled = true;
  pushUserMessage(spec);

  const mode = isWorkflowPage() ? "modify" : "create";
  const message = { type: "indify:submitTask", mode, spec };
  if (pendingAttachments.length > 0) message.attachments = pendingAttachments;
  const res = await sendMessagePromise(message);

  els.sendBtn.disabled = false;
  els.chatInput.focus();
  if (!res.ok) {
    pushSystemMessage("提交失败:" + (res.error || "未知错误"));
  } else {
    pendingAttachments = [];
    renderChips();
  }
  // 成功:SW 会广播 indify:task(queued)
}

// 决策进行中标志:点击后立即禁用决策按钮,防止连点与「旧卡片」误点;新状态帧到达时复位。
let decisionBusy = false;
let decisionBusyTimer = null;

async function doDecision(taskId, action, opts) {
  if (decisionBusy) {
    pushSystemMessage("上一个操作正在处理中,请稍候…");
    return;
  }
  decisionBusy = true;
  if (decisionBusyTimer) clearTimeout(decisionBusyTimer);
  decisionBusyTimer = setTimeout(() => {
    decisionBusy = false;
    renderTaskCard();
  }, 15000); // 兜底:15s 无任何帧则恢复按钮
  renderTaskCard();

  const res = await sendMessagePromise({ type: "indify:decision", taskId, action, ...(opts || {}) });
  if (!res.ok) {
    pushSystemMessage("操作失败:" + (res.error || "未知错误"));
    // 失败后立即向 SW 拉最新任务状态,让卡片回到真实状态(如 planning/plan-ready)
    try {
      const st = await sendMessagePromise({ type: "indify:getStatus" });
      if (st && st.task) {
        onTaskMessage(st.task);
      } else {
        decisionBusy = false;
        renderTaskCard();
      }
    } catch (e) {
      decisionBusy = false;
      renderTaskCard();
    }
  }
  // 成功路径:等 task.frame 到达时 onTaskMessage 会复位 decisionBusy 并重绘
}

function currentPlanFullText() {
  // 用户手改优先;否则用服务器加载的 plan.txt
  const el = els.taskCard.querySelector("#plan-input");
  const domText = el ? el.value : null;
  if (plan && domText != null) return domText;
  return plan && plan.text ? plan.text : "";
}

async function doBuild(taskId) {
  const planText = currentPlanFullText();
  if (!planText.trim()) {
    pushSystemMessage("计划文本为空,无法构建。请等待计划生成或输入内容。");
    return;
  }
  if (plan) plan.edit = null; // 手改文本已作为唯一权威提交
  await doDecision(taskId, "build", { planText });
}

async function doSubmitPlanRevise(taskId) {
  const full = currentPlanFullText();
  const noteEl = els.taskCard.querySelector("#plan-revise-note");
  const note = noteEl ? noteEl.value.trim() : "";
  const feedback = note ? `${full}\n\n【补充说明】\n${note}` : full;
  if (!feedback.trim()) {
    pushSystemMessage("计划文本为空,无法提交修订。");
    return;
  }
  await doDecision(taskId, "revise-plan", { feedback });
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

// F1 附件:📎 按钮与文件选择
els.attachBtn.addEventListener("click", () => els.attachInput.click());
els.attachInput.addEventListener("change", () => {
  handleAttachFiles(els.attachInput.files);
  els.attachInput.value = "";
});
els.planAttachInput.addEventListener("change", () => {
  handlePlanAttachFiles(els.planAttachInput.files);
});
els.attachRow.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-action='remove-attach']");
  if (!chip) return;
  const idx = Number(chip.dataset.idx);
  if (!Number.isNaN(idx) && idx >= 0 && idx < pendingAttachments.length) {
    pendingAttachments.splice(idx, 1);
    renderChips();
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

// 计划文本框手改 → 记录到 plan.edit(容器委托,innerHTML 重绘后依然生效)
els.taskCard.addEventListener("input", (e) => {
  if (e.target && e.target.id === "plan-input" && plan) {
    plan.edit = e.target.value;
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
    case "build":
      doBuild(task.taskId);
      break;
    case "add-attach-plan":
      els.planAttachInput.click();
      break;
    case "toggle-plan-revise": {
      const box = els.taskCard.querySelector(".plan-box .revise-box");
      if (box) box.classList.toggle("show");
      break;
    }
    case "submit-plan-revise":
      doSubmitPlanRevise(task.taskId);
      break;
    case "cancel-plan-revise": {
      const box = els.taskCard.querySelector(".plan-box .revise-box");
      if (box) box.classList.remove("show");
      const ta = els.taskCard.querySelector("#plan-revise-note");
      if (ta) ta.value = "";
      break;
    }
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
      doDecision(task.taskId, "revise", { feedback });
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
  const prev = state.currentTask;
  state.currentTask = task;
  persistPanelState();

  // 新状态帧到达 = 决策已生效:复位决策忙标志,恢复按钮
  decisionBusy = false;
  if (decisionBusyTimer) {
    clearTimeout(decisionBusyTimer);
    decisionBusyTimer = null;
  }

  // F3 流生命周期:新任务/turn 结束(wait 或终态)清空流区,turn 进行中保留缓冲
  const isNewTask = !prev || prev.taskId !== task.taskId;
  if (isNewTask) clearStream();
  else if (!TURNING_STATUSES.has(task.status)) clearStream(); // 正式产物接管(plan-ready/draft-ready/…)

  if (task.status === "plan-ready" && (!prev || prev.taskId !== task.taskId || prev.status !== "plan-ready")) {
    plan = { taskId: task.taskId, text: null, edit: null };
    loadPlan(task.taskId);
  }
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
  } else if (message.type === "indify:stream") {
    onStream(message.data);
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
    if (state.currentTask && state.currentTask.status === "plan-ready") {
      loadPlan(state.currentTask.taskId);
    }
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
      if (state.currentTask.status === "plan-ready") {
        loadPlan(state.currentTask.taskId);
      }
      if (state.currentTask.status === "draft-ready") {
        maybeLoadPreview(state.currentTask.taskId);
      }
    }
  } catch (e) {
    /* 忽略 */
  }
}

init();
