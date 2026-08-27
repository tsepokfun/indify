// Indify Mock Bridge — 本地联调用(可提交,仅用于开发自测,不参与生产)
//
// 用途:在真实 Indify Bridge(bridge/)未实现 / 未启动时,用 Node 起一个假 Bridge,
//       让 Chrome 扩展的 service worker 能连通、走通 v2 两段式全流程:
//       提交任务 → task.frame 序列(planning → plan-ready → building → draft-ready → ready)
//       → 计划确认(build/revise-plan)→ 结构确认(approve/revise)→ 注入。
//
// 用法(纯 Node 无依赖,Node 18+ 即可):
//   node extension/mock-bridge.mjs                          # 默认端口 39181
//   MOCK_BRIDGE_PORT=39182 node extension/mock-bridge.mjs   # 改端口(避开真 Bridge)
//   MOCK_HITL=1 node extension/mock-bridge.mjs              # HITL 模式:停在 plan-ready / draft-ready 等决策
//
// 端口默认 39181 与真 Bridge 一致;若端口被占用(真 Bridge 在跑)会提示冲突并退出。
//
// 实现接口(与 v2 Bridge 契约一致):
//   POST /v1/tasks                       → 201 {taskId, status:"queued"} + 启动帧脚本
//   GET  /v1/tasks/{taskId}              → 任务详情
//   POST /v1/tasks/{taskId}/decision     → 202 {accepted:true}(build / revise-plan / approve / revise)
//   POST /v1/tasks/{taskId}/injected     → 202 {accepted:true} + 推 injecting→done
//   GET  /v1/artifacts/{taskId}/{file}   → ir.json / result.json / workflow.yaml / graph.json / plan.txt / plan-final.txt
//   GET  /v1/adapter/1.16.1              → 读 skills/dify-workflow-dsl/adapter/dify-1.16.1.json
//   WS   /v1/events?token=…              → bridge.status + task.frame + task.stream 帧

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_BRIDGE_PORT || 39181);
const HITL = process.env.MOCK_HITL === "1";
const STEP_DELAY = 700;

// 版本无关:adapter 目录里第一个 dify-*.json 即当前部署版本(与真 Bridge 的 /v1/adapter/{v} 同构)。
const ADAPTER_DIR = path.join(__dirname, "..", "skills", "dify-workflow-dsl", "adapter");
const ADAPTER_FILE = fs.readdirSync(ADAPTER_DIR).find((f) => /^dify-[\d.]+\.json$/.test(f)) || "";
const ADAPTER_PATH = path.join(ADAPTER_DIR, ADAPTER_FILE);
const ADAPTER_META = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(ADAPTER_PATH, "utf8"));
    return { difyVersion: a.difyVersion || "?", dslVersion: a.dslVersion || "?" };
  } catch {
    return { difyVersion: "?", dslVersion: "?" };
  }
})();

const tasks = new Map();
const wsClients = new Set();

// ---------- HTTP 工具 ----------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

// ---------- 产物样例 ----------
function irJson() {
  return JSON.stringify(
    {
      irVersion: "1.0",
      meta: { name: "客服工单分类", description: "mock", mode: "workflow" },
      variables: {},
      nodes: [
        { id: "n_start", type: "start", title: "开始" },
        { id: "n_classify", type: "question_classifier", title: "工单分类" },
        { id: "n_end", type: "end", title: "结束" },
      ],
      edges: [
        { id: "e1", source: { node: "start", handle: "output" }, target: { node: "n_classify", handle: "input" } },
        { id: "e2", source: { node: "n_classify", handle: "class_1" }, target: { node: "n_end", handle: "input" } },
      ],
      bindings: [],
    },
    null,
    2
  );
}

function resultJson(task) {
  const st =
    task.status === "done"
      ? "done"
      : task.status === "ready"
        ? "ready"
        : task.status === "draft-ready"
          ? "draft-ready"
          : "plan-ready";
  const obj = {
    status: st,
    summary: task.summary || (st === "plan-ready" ? planSummary() : "按情绪和主题分派客服工单的 3 节点工作流"),
  };
  if (task.appId) obj.appId = task.appId;
  if (task.appUrl) obj.appUrl = task.appUrl;
  return JSON.stringify(obj, null, 2);
}

function workflowYaml() {
  return [
    "app:",
    "  description: mock workflow",
    "  icon: 🧩",
    "  icon_background: '#FFEAD5'",
    "  mode: workflow",
    "  name: 客服工单分类",
    "kind: app",
    `version: ${ADAPTER_META.dslVersion}`,
    "workflow:",
    "  graph:",
    "    nodes: []",
    "    edges: []",
    "  environment_variables: []",
    "  features: {}",
    "",
  ].join("\n");
}

// modify 模式产物:新 graph(就地写回用)
function graphJson() {
  return JSON.stringify(
    {
      nodes: [
        { id: "start", type: "custom", data: { type: "start", title: "开始" }, position: { x: 0, y: 0 } },
        { id: "n_classify", type: "custom", data: { type: "question_classifier", title: "工单分类(已修改)" }, position: { x: 200, y: 0 } },
        { id: "end", type: "custom", data: { type: "end", title: "结束" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "start", target: "n_classify", sourceHandle: "output", targetHandle: "input" },
        { id: "e2", source: "n_classify", target: "end", sourceHandle: "class_1", targetHandle: "input" },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    null,
    2
  );
}

// ---------- WS 帧编解码(极简,无第三方依赖) ----------
function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendText(socket, text) {
  try {
    socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  } catch (e) {
    /* 忽略 */
  }
}

function sendJson(socket, obj) {
  sendText(socket, JSON.stringify(obj));
}

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const s of wsClients) sendText(s, text);
}

function handleWsData(socket, buf) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const opcode = b0 & 0x0f;
    const b1 = buf[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    offset += 2;
    if (len === 126) {
      if (offset + 2 > buf.length) break;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (offset + 4 > buf.length) break;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (offset + len > buf.length) break;
    let payload = buf.slice(offset, offset + len);
    offset += len;
    if (masked && maskKey) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    if (opcode === 0x8) {
      try { socket.end(); } catch (e) { /* 忽略 */ }
    } else if (opcode === 0x9) {
      try { socket.write(encodeFrame(0xa, payload)); } catch (e) { /* 忽略 */ }
    }
    // opcode 0x1(text)= 客户端心跳,忽略
  }
}

// ---------- 任务脚本(v2 两段式) ----------
function pushFrame(task, extra) {
  task.status = extra.status;
  task.phase = extra.phase || extra.status;
  if (extra.summary !== undefined) task.summary = extra.summary;
  task.updatedAt = Date.now();
  broadcast({
    type: "task.frame",
    data: {
      taskId: task.taskId,
      status: task.status,
      phase: task.phase,
      summary: task.summary,
      error: task.error,
    },
  });
}

// 模拟 Agent 流式输出(F3 联调):在 planning / building 阶段吐几段 delta
function emitStream(task, text) {
  const parts = text.match(/.{1,24}/g) || [text];
  let i = 0;
  const tick = () => {
    if (i >= parts.length) return;
    broadcast({ type: "task.stream", data: { taskId: task.taskId, delta: parts[i] } });
    i += 1;
    setTimeout(tick, 120);
  };
  tick();
}

function planText(task) {
  return (
    `# 实施计划(mock)\n\n` +
    `## 目标\n${task.spec || "示例工作流"}\n\n` +
    `## 节点清单\n- start:开始节点,接收用户输入\n- question_classifier:工单分类,按情绪与主题分派\n- end:结束节点,输出分类结果\n\n` +
    `## 数据流\nstart.output -> question_classifier.input;class_1 -> end.input\n\n` +
    `## 验收要点\n3 节点链路可导入 Dify 控制台并正常渲染。\n`
  );
}

function planSummary() {
  return "计划:3 节点工单分类工作流(计划阶段 mock)";
}

// 阶段表:每个阶段可带 pause(等决策)与 stream(模拟 Agent 输出)
const STAGES = [
  { status: "planning", phase: "planning", stream: "正在分析需求…\n- 确定节点语义类型\n- 设计连边与数据流\n" },
  { status: "plan-ready", phase: "plan-ready", summary: "计划已生成,等待确认。" },
  { status: "building", phase: "building", stream: "按最终计划构建 IR…\n- start -> question_classifier\n- question_classifier -> end\n" },
  { status: "draft-ready", phase: "draft-ready", summary: "已生成 3 节点工作流结构,等待确认。" },
  { status: "finalizing", phase: "finalizing" },
  { status: "ready", phase: "ready", summary: "终稿已就绪,可注入画布。" },
];

function runStage(taskId, fromIndex) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.paused = false;
  let i = fromIndex;
  const next = () => {
    if (i >= STAGES.length) return;
    const stage = STAGES[i];
    const isPlanReady = stage.status === "plan-ready";
    const isDraft = stage.status === "draft-ready";
    if (stage.stream) emitStream(task, stage.stream);
    pushFrame(task, stage);
    i += 1;
    if (HITL && isPlanReady && !task.built) {
      task.pausedAt = "plan-ready";
      return; // 停在计划确认
    }
    if (HITL && isDraft && !task.approved) {
      task.pausedAt = "draft-ready";
      return; // 停在结构确认
    }
    setTimeout(next, STEP_DELAY);
  };
  next();
}

function runScript(taskId) {
  runStage(taskId, 0);
}

// 计划阶段:build(携带最终计划文本)/ revise-plan(重写计划)
function onBuild(task) {
  task.built = true;
  task.planFinal = "已记录用户最终计划文本";
  if (task.pausedAt === "plan-ready") {
    runStage(task.taskId, 2); // building 起继续
  }
}

function onRevisePlan(task) {
  task.built = false;
  if (task.pausedAt === "plan-ready") {
    // 模拟 Agent 重写计划:回 planning → plan-ready
    pushFrame(task, { status: "planning", phase: "planning" });
    emitStream(task, "按反馈修订计划…\n- 吸收补充说明\n- 重写节点清单\n");
    setTimeout(() => {
      pushFrame(task, { status: "plan-ready", phase: "plan-ready", summary: "计划已修订,等待确认。" });
      task.pausedAt = "plan-ready";
    }, STEP_DELAY);
  }
}

function onApprove(task) {
  task.approved = true;
  if (task.pausedAt === "draft-ready") {
    runStage(task.taskId, 4); // finalizing 起继续
  }
}

function onRevise(task) {
  task.approved = false;
  if (task.pausedAt === "draft-ready") {
    pushFrame(task, { status: "agent-running", phase: "agent-running" });
    setTimeout(() => {
      pushFrame(task, { status: "draft-ready", phase: "draft-ready", summary: "已根据修改意见重新生成,等待确认。" });
      task.pausedAt = "draft-ready";
    }, STEP_DELAY);
  }
}

// ---------- 路由 ----------
async function route(req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  const m = req.method;

  if (m === "GET" && p === "/v1/health") {
    return json(res, 200, { status: "ok", name: "indify-mock-bridge", version: "0.1.0-mock" });
  }

  const adapterMatch = /^\/v1\/adapter\/([\d.]+)$/.exec(p);
  if (m === "GET" && adapterMatch) {
    try {
      const raw = readFileSync(ADAPTER_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(raw) });
      return res.end(raw);
    } catch (e) {
      return json(res, 500, { error: "adapter 读取失败:" + ((e && e.message) || e) });
    }
  }

  if (m === "POST" && p === "/v1/tasks") {
    const body = await readBody(req);
    const taskId = "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const task = {
      taskId,
      status: "queued",
      mode: body.mode || "create",
      spec: body.spec || "",
      phase: "queued",
      sessionId: body.sessionId || "sess_" + Math.random().toString(36).slice(2, 10),
      context: body.context || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      appId: null,
      appUrl: null,
      approved: false,
      built: false,
      pausedAt: null,
      planFinal: null,
    };
    tasks.set(taskId, task);
    json(res, 201, { taskId, status: "queued" });
    broadcast({
      type: "task.frame",
      data: { taskId, status: "queued", phase: "queued" },
    });
    runScript(taskId);
    return;
  }

  const taskGet = p.match(/^\/v1\/tasks\/([^/]+)$/);
  if (taskGet && m === "GET") {
    const task = tasks.get(taskGet[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    return json(res, 200, {
      taskId: task.taskId,
      status: task.status,
      mode: task.mode,
      spec: task.spec,
      phase: task.phase,
      summary: task.summary,
      error: task.error,
      sessionId: task.sessionId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  const decision = p.match(/^\/v1\/tasks\/([^/]+)\/decision$/);
  if (decision && m === "POST") {
    const task = tasks.get(decision[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    const body = await readBody(req);
    if (body.action === "build") onBuild(task);
    else if (body.action === "revise-plan") onRevisePlan(task);
    else if (body.action === "approve") onApprove(task);
    else if (body.action === "revise") onRevise(task);
    return json(res, 202, { accepted: true });
  }

  const injected = p.match(/^\/v1\/tasks\/([^/]+)\/injected$/);
  if (injected && m === "POST") {
    const task = tasks.get(injected[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    const body = await readBody(req);
    task.appId = body.appId || "mock-app-" + task.taskId;
    task.appUrl = body.appUrl || "http://localhost/app/" + task.appId + "/workflow";
    json(res, 202, { accepted: true });
    pushFrame(task, { status: "injecting", phase: "injecting" });
    setTimeout(() => {
      pushFrame(task, { status: "done", phase: "done", summary: "注入完成。" });
    }, 600);
    return;
  }

  // F1:计划阶段补传附件(mock:仅确认,不实际处理)
  const attAdd = p.match(/^\/v1\/tasks\/([^/]+)\/attachments$/);
  if (attAdd && m === "POST") {
    const task = tasks.get(attAdd[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    const body = await readBody(req);
    const names = (body.attachments || []).map((a) => a.name);
    task.attachments = (task.attachments || []).concat(names);
    broadcast({ type: "task.stream", data: { taskId: task.taskId, note: "附件已补传:" + names.join(",") } });
    return json(res, 202, { accepted: true, added: names });
  }

  const artifact = p.match(/^\/v1\/artifacts\/([^/]+)\/([^/]+)$/);
  if (artifact && m === "GET") {
    const task = tasks.get(artifact[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    const file = artifact[2];
    let content;
    if (file === "ir.json") content = irJson();
    else if (file === "result.json") content = resultJson(task);
    else if (file === "workflow.yaml") content = workflowYaml();
    else if (file === "graph.json") content = graphJson();
    else if (file === "plan.txt") content = planText(task);
    else if (file === "plan-final.txt") content = task.planFinal || planText(task);
    else return json(res, 404, { error: "artifact not found" });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(content) });
    return res.end(content);
  }

  return json(res, 404, { error: "not found" });
}

// ---------- HTTP server ----------
const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    json(res, 500, { error: "internal:" + ((e && e.message) || e) });
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `[mock-bridge] 端口 ${PORT} 已被占用(可能真 Bridge 正在运行)。\n` +
        `  请先停掉真 Bridge,或用 MOCK_BRIDGE_PORT 指定其它端口,例如:\n` +
        `  $env:MOCK_BRIDGE_PORT=39182; node extension/mock-bridge.mjs`
    );
    process.exit(1);
  }
  throw e;
});

// ---------- WS upgrade ----------
server.on("upgrade", (req, socket) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/v1/events") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  wsClients.add(socket);
  socket.on("data", (buf) => handleWsData(socket, buf));
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
  sendJson(socket, {
    type: "bridge.status",
    data: { bridge: "mock", difyVersion: ADAPTER_META.difyVersion, state: "connected", note: "indify mock bridge" },
  });
});

// 保活:每 15s 推一次 bridge.status,避免 SW 僵死检测误判重连
setInterval(() => {
  broadcast({
    type: "bridge.status",
    data: { bridge: "mock", difyVersion: ADAPTER_META.difyVersion, state: "connected", note: "indify mock bridge" },
  });
}, 15000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-bridge] 监听 http://127.0.0.1:${PORT}  (WS /v1/events?token=…)`);
  console.log(`[mock-bridge] HITL 模式:${HITL ? "开(停在 draft-ready 等 approve)" : "关(自动推到底)"}`);
  console.log(`[mock-bridge] adapter 读取自:${ADAPTER_PATH}`);
});
