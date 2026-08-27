/**
 * Indify Bridge(v2 两段式)
 * - GET  /v1/health                    健康检查 + 两端连通性 + adapter 版本(无 token)
 * - POST /v1/tasks                     提交任务 {mode:"create"|"modify", spec, sessionId?, context?}
 * - GET  /v1/tasks/{taskId}            任务状态
 * - POST /v1/tasks/{taskId}/decision   HITL:{action:"build"|"revise-plan"|"approve"|"revise", planText?, feedback?}
 * - POST /v1/tasks/{taskId}/injected   注入完成回报 {appId?, appUrl?}
 * - GET  /v1/artifacts/{taskId}/{file} 产物文件(ir.json / workflow.yaml / graph.json / result.json / plan.txt / plan-final.txt)
 * - GET  /v1/adapter/{version}         adapter JSON
 * - WS   /v1/events?token=…            帧:bridge.status / task.frame / task.stream
 * 认证:除 health 外要求 X-Indify-Token 头或 ?token=;Bridge 只监听 127.0.0.1。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, RC_PATH, type BridgeConfig } from './config.js';
import { listAdapters, getAdapter } from './adapter.js';
import { probeDsh, probeDify } from './health.js';
import { DshClient } from './dsh.js';
import { TaskStore } from './tasks.js';
import type { TaskContext } from './tasks.js';
import { Orchestrator } from './orchestrator.js';

const VERSION = '0.2.0';

const cfg: BridgeConfig = loadConfig();

// 本地守护进程韧性:未捕获的 promise 拒绝只记录不崩溃(Node 默认会退出进程,
// 一次异常请求不应让 Bridge 掉线;任务状态全部落盘,重启可恢复)。
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] unhandledRejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

/* ---------- WS 客户端集(用于广播) ---------- */
const wsClients = new Set<WebSocket>();
function broadcast(obj: unknown): void {
  const text = JSON.stringify(obj);
  for (const c of wsClients) {
    try {
      c.send(text);
    } catch {
      /* 忽略单个坏连接 */
    }
  }
}

/* ---------- 任务与编排 ---------- */
const store = new TaskStore((frame) => broadcast(frame));
const dsh = new DshClient(cfg.dsh);
const orchestrator = new Orchestrator(dsh, store, cfg);
store.loadAll();
dsh.startMux();

/* ---------- HTTP 工具 ---------- */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function authOk(req: IncomingMessage): boolean {
  const header = req.headers['x-indify-token'];
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = url.searchParams.get('token');
  return header === cfg.token || query === cfg.token;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
  const path = url.pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-indify-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/v1/health') {
    const [dshState, difyState] = await Promise.all([probeDsh(cfg), probeDify(cfg)]);
    json(res, 200, {
      ok: dshState.reachable && difyState.reachable,
      bridge: { version: VERSION, port: cfg.port, rcPath: RC_PATH },
      dsh: dshState,
      dify: difyState,
      adapters: listAdapters().map((a) => a.version),
    });
    return;
  }

  if (!authOk(req)) {
    json(res, 401, { error: 'unauthorized', hint: '缺少或错误的 X-Indify-Token(见 .indifyrc.yaml 的 token)' });
    return;
  }

  // ---- 任务提交 ----
  if (req.method === 'POST' && path === '/v1/tasks') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: 'bad-json' });
      return;
    }
    const mode = body['mode'] === 'modify' ? 'modify' : 'create';
    const spec = typeof body['spec'] === 'string' ? body['spec'].trim() : '';
    if (!spec) {
      json(res, 400, { error: 'spec-required' });
      return;
    }
    const task = store.create({
      mode,
      spec,
      context: body['context'] as TaskContext | undefined,
      sessionId: typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined,
    });
    orchestrator.kick();
    json(res, 201, { taskId: task.taskId, status: task.status });
    return;
  }

  // ---- 单任务操作 ----
  const taskMatch = /^\/v1\/tasks\/([A-Za-z0-9_-]+)(\/(decision|injected))?$/.exec(path);
  if (taskMatch) {
    const taskId = taskMatch[1]!;
    const sub = taskMatch[3];
    const task = store.get(taskId);
    if (!task) {
      json(res, 404, { error: 'task-not-found', taskId });
      return;
    }
    if (req.method === 'GET' && !sub) {
      json(res, 200, task);
      return;
    }
    if (req.method === 'POST' && sub === 'decision') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: 'bad-json' });
        return;
      }
      const raw = body['action'];
      const action =
        raw === 'approve' || raw === 'revise' || raw === 'build' || raw === 'revise-plan'
          ? (raw as 'approve' | 'revise' | 'build' | 'revise-plan')
          : null;
      if (!action) {
        json(res, 400, { error: 'action-must-be-approve-revise-build-or-revise-plan' });
        return;
      }
      try {
        void orchestrator.decide(taskId, action, {
          feedback: typeof body['feedback'] === 'string' ? body['feedback'] : undefined,
          planText: typeof body['planText'] === 'string' ? body['planText'] : undefined,
        });
      } catch (e) {
        json(res, 409, { error: 'decision-rejected', message: e instanceof Error ? e.message : String(e) });
        return;
      }
      json(res, 202, { accepted: true });
      return;
    }
    if (req.method === 'POST' && sub === 'injected') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: 'bad-json' });
        return;
      }
      orchestrator.markInjected(
        taskId,
        typeof body['appId'] === 'string' ? body['appId'] : undefined,
        typeof body['appUrl'] === 'string' ? body['appUrl'] : undefined,
      );
      json(res, 202, { accepted: true });
      return;
    }
    json(res, 405, { error: 'method-not-allowed' });
    return;
  }

  // ---- adapter 列表(版本探测用) ----
  if (req.method === 'GET' && path === '/v1/adapters') {
    json(res, 200, { items: listAdapters() });
    return;
  }

  // ---- 产物 ----
  const artifactMatch = /^\/v1\/artifacts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(path);
  if (req.method === 'GET' && artifactMatch) {
    const buf = store.readArtifact(artifactMatch[1]!, artifactMatch[2]!);
    if (!buf) {
      json(res, 404, { error: 'artifact-not-found' });
      return;
    }
    const file = artifactMatch[2]!;
    res.writeHead(200, {
      'content-type': file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/yaml; charset=utf-8',
      'content-length': buf.length,
    });
    res.end(buf);
    return;
  }

  // ---- adapter ----
  const adapterMatch = /^\/v1\/adapter\/([\d.]+)$/.exec(path);
  if (req.method === 'GET' && adapterMatch) {
    const adapter = getAdapter(adapterMatch[1]!);
    if (!adapter) {
      json(res, 404, { error: 'adapter-not-found', version: adapterMatch[1], available: listAdapters().map((a) => a.version) });
      return;
    }
    json(res, 200, adapter);
    return;
  }

  json(res, 404, { error: 'not-found', path });
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('[bridge] http error:', e);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  });
});

/* ---------- WS /v1/events ---------- */
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
  if (url.pathname !== '/v1/events') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') ?? req.headers['x-indify-token'];
  if (token !== cfg.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WebSocket) => {
  wsClients.add(ws);
  ws.send(
    JSON.stringify({
      type: 'bridge.status',
      data: { bridge: VERSION, difyVersion: 'auto-detect', state: 'idle', note: 'M2:任务链路已接入' },
    }),
  );
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[bridge] Indify Bridge v${VERSION} 监听 http://127.0.0.1:${cfg.port}`);
  console.log(`[bridge] DSH: ${cfg.dsh.baseUrl}${cfg.dsh.apiPath} | Dify: ${cfg.dify.consoleUrl}${cfg.dify.apiPrefix}`);
  console.log(`[bridge] adapters: ${listAdapters().map((a) => a.version).join(', ') || '(无)'}`);
});
