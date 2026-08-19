// Indify Mock Bridge — 本地联调用(可提交,仅用于开发自测,不参与生产)
//
// 用途:在真实 Indify Bridge(bridge/)未实现 / 未启动时,用 Node 起一个假 Bridge,
//       让 Chrome 扩展的 service worker 能连通、走通 U1 全流程:
//       提交任务 → 收到 task.frame 序列 → draft-ready 预览 → 确认 → ready → 注入。
//
// 用法(纯 Node 无依赖,Node 18+ 即可):
//   node extension/mock-bridge.mjs                          # 默认端口 39181
//   MOCK_BRIDGE_PORT=39182 node extension/mock-bridge.mjs   # 改端口(避开真 Bridge)
//   MOCK_HITL=1 node extension/mock-bridge.mjs              # HITL 模式:停在 draft-ready 等 approve
//
// 端口默认 39181 与真 Bridge 一致;若端口被占用(真 Bridge 在跑)会提示冲突并退出。
//
// 实现接口(与 M2 Bridge 契约一致):
//   POST /v1/tasks                       → 201 {taskId, status:"queued"} + 启动帧脚本
//   GET  /v1/tasks/{taskId}              → 任务详情
//   POST /v1/tasks/{taskId}/decision     → 202 {accepted:true}
//   POST /v1/tasks/{taskId}/injected     → 202 {accepted:true} + 推 injecting→done
//   GET  /v1/artifacts/{taskId}/{file}   → ir.json / result.json / workflow.yaml
//   GET  /v1/adapter/1.16.1              → 读 skills/dify-workflow-dsl/adapter/dify-1.16.1.json
//   WS   /v1/events?token=…              → bridge.status + task.frame 序列

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_BRIDGE_PORT || 39181);
const HITL = process.env.MOCK_HITL === "1";
const STEP_DELAY = 700;

const ADAPTER_PATH = path.join(
  __dirname,
  "..",
  "skills",
  "dify-workflow-dsl",
  "adapter",
  "dify-1.16.1.json"
);

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
  const obj = {
    status: task.status === "done" ? "done" : task.status === "ready" ? "ready" : "draft-ready",
    summary: task.summary || "按情绪和主题分派客服工单的 3 节点工作流",
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
    "version: 0.7.0",
    "workflow:",
    "  graph:",
    "    nodes: []",
    "    edges: []",
    "  environment_variables: []",
    "  features: {}",
    "",
  ].join("\n");
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

// ---------- 任务脚本 ----------
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

// 自动脚本:queued(创建时已推)→ agent-running → draft-ready → finalizing → ready
const STEPS = [
  { status: "agent-running", phase: "agent-running" },
  { status: "draft-ready", phase: "draft-ready", summary: "已生成 3 节点工作流结构,等待确认。" },
  { status: "finalizing", phase: "finalizing" },
  { status: "ready", phase: "ready", summary: "终稿已就绪,可注入画布。" },
];

function runScript(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;

  let i = 0;
  const next = () => {
    if (i >= STEPS.length) return;
    const step = STEPS[i];
    const isDraft = i === 1;
    pushFrame(task, step);
    i += 1;
    if (HITL && isDraft && !task.approved) {
      task.paused = true;
      return; // 停在 draft-ready
    }
    setTimeout(next, STEP_DELAY);
  };
  next();
}

function onApprove(task) {
  task.approved = true;
  if (task.paused) {
    task.paused = false;
    pushFrame(task, { status: "finalizing", phase: "finalizing" });
    setTimeout(() => {
      pushFrame(task, { status: "ready", phase: "ready", summary: "终稿已就绪,可注入画布。" });
    }, STEP_DELAY);
  }
}

function onRevise(task) {
  task.approved = false;
  task.paused = false;
  pushFrame(task, { status: "agent-running", phase: "agent-running" });
  setTimeout(() => {
    pushFrame(task, { status: "draft-ready", phase: "draft-ready", summary: "已根据修改意见重新生成,等待确认。" });
    task.paused = true;
  }, STEP_DELAY);
}

// ---------- 路由 ----------
async function route(req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  const m = req.method;

  if (m === "GET" && p === "/v1/health") {
    return json(res, 200, { status: "ok", name: "indify-mock-bridge", version: "0.1.0-mock" });
  }

  if (m === "GET" && p === "/v1/adapter/1.16.1") {
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
      sessionId: body.sessionId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      appId: null,
      appUrl: null,
      approved: false,
      paused: false,
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
    if (body.action === "approve") onApprove(task);
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

  const artifact = p.match(/^\/v1\/artifacts\/([^/]+)\/([^/]+)$/);
  if (artifact && m === "GET") {
    const task = tasks.get(artifact[1]);
    if (!task) return json(res, 404, { error: "task not found" });
    const file = artifact[2];
    let content;
    if (file === "ir.json") content = irJson();
    else if (file === "result.json") content = resultJson(task);
    else if (file === "workflow.yaml") content = workflowYaml();
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
    data: { bridge: "mock", difyVersion: "1.16.1", state: "connected", note: "indify mock bridge" },
  });
});

// 保活:每 15s 推一次 bridge.status,避免 SW 僵死检测误判重连
setInterval(() => {
  broadcast({
    type: "bridge.status",
    data: { bridge: "mock", difyVersion: "1.16.1", state: "connected", note: "indify mock bridge" },
  });
}, 15000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-bridge] 监听 http://127.0.0.1:${PORT}  (WS /v1/events?token=…)`);
  console.log(`[mock-bridge] HITL 模式:${HITL ? "开(停在 draft-ready 等 approve)" : "关(自动推到底)"}`);
  console.log(`[mock-bridge] adapter 读取自:${ADAPTER_PATH}`);
});
