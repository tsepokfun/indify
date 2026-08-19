/**
 * DSH Web GUI /api 客户端(Bridge 侧)。
 * 线格式见 docs/m0-findings.md §1:
 *   - 一元调用:POST /api/<method>,body = client-request 信封 {type,rpcId,method,payload}
 *   - 事件流:/api/events.mux 仅 WebSocket;帧 = server-request 信封 {type,rpcId,method,payload}
 *   - turn 结束判定:payload.type==="session/event" && event.type==="turn/end"
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

export interface DshConfig {
  baseUrl: string;
  apiPath: string;
  eventsMuxPath: string;
}

export interface RpcResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; details?: unknown };
}

interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data?: { turn?: number; reason?: { kind?: string }; content?: unknown };
}

interface HistoryResponse {
  events: { event: SessionEvent }[];
  hasMore: boolean;
}

type FrameListener = (payload: Record<string, unknown>) => void;

/** 转数字/字符串安全取值 */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

export class DshClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private readonly frameListeners = new Set<FrameListener>();

  constructor(private readonly cfg: DshConfig) {}

  get muxUrl(): string {
    return `${this.cfg.baseUrl.replace(/^http/, 'ws')}${this.cfg.eventsMuxPath}`;
  }

  /** 一元 RPC。返回解析后的 result;HTTP 层失败抛错。 */
  async rpc<T = unknown>(method: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResult<T>> {
    const body = { type: 'client-request', rpcId: randomUUID(), method, payload };
    const res = await fetch(`${this.cfg.baseUrl}${this.cfg.apiPath}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`DSH ${method} HTTP ${res.status}`);
    const full = (await res.json()) as { result?: RpcResult<T> };
    if (!full.result) throw new Error(`DSH ${method} 响应缺 result`);
    return full.result;
  }

  async createSession(cwd: string, sessionId?: string): Promise<string> {
    const r = await this.rpc<{ sessionId: string }>('session.create', { cwd, ...(sessionId ? { sessionId } : {}) });
    if (!r.ok || !r.value?.sessionId) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r)}`);
    return r.value.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const r = await this.rpc<{ accepted: boolean }>('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    });
    if (!r.ok || r.value?.accepted !== true) throw new Error(`session.prompt 失败: ${JSON.stringify(r.error ?? r)}`);
  }

  async history(sessionId: string, maxMessages = 50): Promise<SessionEvent[]> {
    const r = await this.rpc<HistoryResponse>('session.history', { sessionId, maxMessages });
    if (!r.ok || !r.value) return [];
    return r.value.events.map((e) => e.event);
  }

  /** 会话最后 turn 号(无 turn 时 -1)。 */
  async lastTurnNumber(sessionId: string): Promise<number> {
    const events = await this.history(sessionId, 5);
    let last = -1;
    for (const e of events) {
      if (e.type === 'turn/end' && typeof e.data?.turn === 'number') last = Math.max(last, e.data.turn);
    }
    return last;
  }

  /** 最后一条 assistant 文本(供调试/摘要兜底)。 */
  async lastAssistantText(sessionId: string): Promise<string> {
    const events = await this.history(sessionId, 20);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== 'assistant/message') continue;
      const msg = e.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
      const parts = (msg?.message?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (parts.trim()) return parts;
    }
    return '';
  }

  /* ---------- mux 订阅 ---------- */

  startMux(): void {
    if (this.ws) return;
    this.connectMux();
  }

  private connectMux(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.muxUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = 1000;
      console.log('[bridge] DSH mux 已连接');
    });
    ws.on('message', (data) => {
      let full: { type?: string; method?: string; payload?: Record<string, unknown> };
      try {
        full = JSON.parse(String(data));
      } catch {
        return;
      }
      if (full.type !== 'server-request' || !full.payload) return;
      for (const l of this.frameListeners) {
        try {
          l(full.payload);
        } catch (e) {
          console.warn('[bridge] mux listener error:', e);
        }
      }
    });
    ws.on('error', () => {
      /* onclose 兜底 */
    });
    ws.on('close', () => {
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.warn(`[bridge] DSH mux 断开,${this.backoffMs}ms 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.connectMux();
    }, this.backoffMs);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /**
   * 等待会话的下一次 turn/end(mux 帧 + 历史轮询兜底,双保险)。
   * @param afterTurn turn 号必须 > afterTurn。
   */
  async waitTurnEnd(sessionId: string, afterTurn: number, timeoutMs = 600_000): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let done = false;
      const finish = (turn: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poller);
        off();
        resolve(turn);
      };
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poller);
        off();
        reject(err);
      };

      const off = this.onFrame((payload) => {
        if (payload.type !== 'session/event') return;
        if (asStr(payload.sessionId) !== sessionId) return;
        const ev = payload.event as SessionEvent | undefined;
        if (ev?.type === 'turn/end' && typeof ev.data?.turn === 'number' && ev.data.turn > afterTurn) {
          finish(ev.data.turn);
        }
      });

      const timer = setTimeout(() => fail(new Error(`等待 turn 结束超时(${timeoutMs / 1000}s)`)), timeoutMs);
      const poller = setInterval(async () => {
        try {
          const turn = await this.lastTurnNumber(sessionId);
          if (turn > afterTurn) finish(turn);
        } catch {
          /* 下一轮再试 */
        }
      }, 3000);
    });
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
  }
}
