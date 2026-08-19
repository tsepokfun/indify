#!/usr/bin/env node
/**
 * Indify M0 探针:实测 DSH Web GUI(127.0.0.1:3080)/api 会话三件套与 events.mux。
 * 用法: node tools/probe-dsh.mjs [--no-prompt]
 *   --no-prompt  只测 create/list/history,不发真实 prompt(不发模型调用)。
 * 产物: generated/m0/dsh-probe.json(机器可读结论)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3080';
const WS_BASE = 'ws://127.0.0.1:3080';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'm0');
const OUT_FILE = join(OUT_DIR, 'dsh-probe.json');

const findings = { ok: false, steps: {}, eventsMux: null, trustWall: null, sessionApi: null };
const log = (k, v) => { findings.steps[k] = v; console.log(`[${k}]`, JSON.stringify(v, null, 2).slice(0, 4000)); };

const mint = () => crypto.randomUUID();

async function rpc(method, payload, { timeoutMs = 30000 } = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: mint(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { rawText: text.slice(0, 500) }; }
  return { httpStatus: res.status, contentType: res.headers.get('content-type'), body: json };
}

/** 连接 events.mux WebSocket;返回 { ws, frames: [], onFrame(cb) }。frames 收集后统一分析。 */
function connectMux() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/events.mux`);
    const frames = [];
    const listeners = [];
    ws.addEventListener('open', () => {
      resolve({ ws, frames, onFrame: (cb) => listeners.push(cb) });
    });
    ws.addEventListener('message', (ev) => {
      let parsed = null, parseError = null;
      try { parsed = JSON.parse(ev.data); } catch (e) { parseError = String(e); }
      const rec = { raw: String(ev.data).slice(0, 300), parsed, parseError, at: Date.now() };
      frames.push(rec);
      for (const cb of listeners) cb(rec);
    });
    ws.addEventListener('error', (ev) => reject(new Error(`mux ws error: ${ev.message ?? 'unknown'}`)));
    setTimeout(() => reject(new Error('mux ws open timeout')), 10000);
  });
}

async function main() {
  const noPrompt = process.argv.includes('--no-prompt');

  // 1. 信任墙:无浏览器标记的 loopback POST(本测试自身即是证据:Host=127.0.0.1:3080、无 Origin)
  // 另测:带浏览器标记(bogus Origin)应被拒。
  const listResp = await rpc('session.list', {});
  log('session.list', { httpStatus: listResp.httpStatus, body: listResp.body });

  const badOrigin = await fetch(`${BASE}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ type: 'client-request', rpcId: mint(), method: 'session.list', payload: {} }),
  });
  findings.trustWall = {
    noMarkerLoopbackPost: { status: listResp.httpStatus, ok: listResp.httpStatus === 200 },
    bogusOriginPost: { status: badOrigin.status },
    nonBrowserLoopbackPasses: listResp.httpStatus === 200,
    bogusOriginBlocked: badOrigin.status === 403,
  };
  log('trustWall', findings.trustWall);

  // 2. 纯 HTTP GET events.mux → 期望 426(无 SSE 回退,网络客户端必须走 WS)
  const getMux = await fetch(`${BASE}/api/events.mux`, { headers: { accept: 'text/event-stream' } });
  findings.eventsMux = { httpGetStatus: getMux.status, httpGetBody: (await getMux.text()).slice(0, 200) };
  log('eventsMux.httpGet', findings.eventsMux);

  // 3. session.create
  const createResp = await rpc('session.create', { cwd: 'D:\\difyIndify' });
  const sessionId = createResp.body?.result?.value?.sessionId;
  log('session.create', { httpStatus: createResp.httpStatus, body: createResp.body });
  if (!sessionId) { console.error('session.create 失败,终止'); return; }

  // 4. events.mux WS 帧(先连,再发 prompt,等 turn/end)
  const { ws, frames, onFrame } = await connectMux();
  findings.eventsMux.wsConnected = true;
  log('eventsMux.wsConnected', true);

  const muxSummary = { subscribedFrames: [], sawTurnEnd: false, frameTypes: new Set(), firstFrameRaw: null, turnEndDetail: null, assistantChunks: 0 };
  const turnEndPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), noPrompt ? 3000 : 180000);
    onFrame((rec) => {
      if (!rec.parsed) return;
      const full = rec.parsed;
      if (muxSummary.firstFrameRaw === null) muxSummary.firstFrameRaw = rec.raw;
      const kind = `${full.type}|${full.method ?? ''}|${full.payload?.type ?? ''}`;
      muxSummary.frameTypes.add(kind);
      if (full.payload?.type === 'session/subscribed') muxSummary.subscribedFrames.push(full.payload);
      if (full.payload?.type === 'session/event') {
        const ev = full.payload.event;
        if (ev.type === 'turn/end' && full.payload.sessionId === sessionId) {
          muxSummary.sawTurnEnd = true;
          muxSummary.turnEndDetail = { reason: ev.data?.reason, turn: ev.data?.turn };
          clearTimeout(timer);
          resolve('turn-end');
        }
      }
    });
  });

  // 5. session.prompt(可 --no-prompt 跳过)
  if (!noPrompt) {
    const promptResp = await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Indify M0 连通性测试。请只回复两个字:成功。' }],
    }, { timeoutMs: 30000 });
    log('session.prompt', { httpStatus: promptResp.httpStatus, body: promptResp.body });
    const waitResult = await turnEndPromise;
    log('eventsMux.turnEndWait', waitResult);
  }

  // 6. session.history 尾页
  const histResp = await rpc('session.history', { sessionId });
  const hist = histResp.body?.result?.value ?? {};
  const tailEvents = (hist.events ?? []).map((e) => ({ type: e.event?.type, seq: e.event?.seq }));
  const lastAssistant = [...(hist.events ?? [])].reverse().find((e) => e.event?.type === 'assistant/message');
  log('session.history', {
    httpStatus: histResp.httpStatus,
    hasMore: hist.hasMore,
    eventCount: hist.events?.length,
    tailEventTypes: tailEvents.slice(-15),
    lastAssistantText: lastAssistant?.event?.data?.message?.content?.map((b) => b.text ?? '').join('').slice(0, 500),
  });

  muxSummary.frameTypes = [...muxSummary.frameTypes];
  findings.eventsMux.ws = muxSummary;
  findings.sessionApi = {
    createRequest: { cwd: 'D:\\difyIndify' },
    createResponseShape: createResp.body,
    promptAccepted: true,
    historyShape: { hasMore: hist.hasMore, eventKeys: Object.keys(hist.events?.[0]?.event ?? {}) },
  };
  findings.ok = true;

  ws.close();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(findings, null, 2), 'utf8');
  console.log(`\n== 结论已写入 ${OUT_FILE}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
