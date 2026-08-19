/**
 * Indify Bridge(M1 最小版)
 * - GET  /v1/health            健康检查 + 两端连通性 + adapter 版本列表(无 token 要求)
 * - GET  /v1/adapter/{version} 返回 adapter JSON(需 token)
 * - WS   /v1/events            任务事件流(M1:握手 + status 帧占位;M2 接任务状态机)
 * 认证:Bridge 只监听 127.0.0.1;除 health 外要求 `X-Indify-Token` 头或 `?token=` 查询参数。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, RC_PATH, type BridgeConfig } from './config.js';
import { listAdapters, getAdapter } from './adapter.js';
import { probeDsh, probeDify } from './health.js';

const VERSION = '0.1.0';

const cfg: BridgeConfig = loadConfig();

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

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
  const path = url.pathname;

  // CORS:扩展 origin(chrome-extension://)与 sidePanel 页面的 fetch 需要;仅放开只读面
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-indify-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/v1/health') {
    const [dsh, dify] = await Promise.all([probeDsh(cfg), probeDify(cfg)]);
    json(res, 200, {
      ok: dsh.reachable && dify.reachable,
      bridge: { version: VERSION, port: cfg.port, rcPath: RC_PATH },
      dsh,
      dify,
      adapters: listAdapters().map((a) => a.version),
    });
    return;
  }

  if (!authOk(req)) {
    json(res, 401, { error: 'unauthorized', hint: '缺少或错误的 X-Indify-Token(见 .indifyrc.yaml 的 token)' });
    return;
  }

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
  // 握手验证 token(查询参数或 Sec-WebSocket-Protocol 子协议)
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
  ws.send(
    JSON.stringify({
      type: 'bridge.status',
      data: { bridge: VERSION, difyVersion: 'auto-detect', state: 'idle', note: 'M1 骨架:任务帧 M2 接入' },
    }),
  );
  ws.on('error', (e) => console.warn('[bridge] ws error:', e.message));
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[bridge] Indify Bridge v${VERSION} 监听 http://127.0.0.1:${cfg.port}`);
  console.log(`[bridge] DSH: ${cfg.dsh.baseUrl}${cfg.dsh.apiPath} | Dify: ${cfg.dify.consoleUrl}${cfg.dify.apiPrefix}`);
  console.log(`[bridge] adapters: ${listAdapters().map((a) => a.version).join(', ') || '(无)'}`);
});
