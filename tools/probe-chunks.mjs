#!/usr/bin/env node
/**
 * F3 探针:实测 DSH events.mux 中 assistant/chunk 帧的精确结构(Bridge 转发流的原料)。
 * 做法:session.create → 连 mux → session.prompt(让它写一段小作文)→ 收集:
 *   - assistant/chunk 帧的 event.data 结构(取 delta 的路径)
 *   - tool/call 帧结构(取工具名)
 * 产物:generated/v2/chunk-probe.json + 控制台摘要。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3080';
const WS_BASE = 'ws://127.0.0.1:3080';
const CWD = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(CWD, 'generated', 'v2', 'chunk-probe.json');

async function rpc(method, payload, timeoutMs = 30000) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  return (await res.json()).result;
}

const created = await rpc('session.create', { cwd: CWD });
if (!created.ok) throw new Error('session.create 失败: ' + JSON.stringify(created.error));
const sessionId = created.value.sessionId;

const findings = { sessionId, chunkSamples: [], toolSamples: [], otherEventTypes: new Set(), chunkDataShapes: new Set() };
const ws = new WebSocket(`${WS_BASE}/api/events.mux`);
let promptAccepted = false;
let turnEnded = false;

ws.addEventListener('message', (ev) => {
  let f;
  try { f = JSON.parse(String(ev.data)); } catch { return; }
  if (!f.payload || f.payload.type !== 'session/event') return;
  if (f.payload.sessionId !== sessionId) return;
  const event = f.payload.event;
  findings.otherEventTypes.add(event.type);
  if (event.type === 'assistant/chunk') {
    const shape = JSON.stringify(Object.keys(event.data ?? {})).slice(0, 120);
    findings.chunkDataShapes.add(shape);
    if (findings.chunkSamples.length < 6) {
      findings.chunkSamples.push({ dataKeys: Object.keys(event.data ?? {}), data: event.data });
    }
  }
  if (event.type === 'tool/call') {
    if (findings.toolSamples.length < 4) findings.toolSamples.push({ data: event.data });
  }
  if (event.type === 'turn/end') turnEnded = true;
});
ws.addEventListener('open', async () => {
  // 等 subscribed 帧后发 prompt
  setTimeout(async () => {
    const r = await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '请分三步说明「如何给一段文本做分词」:先写一个编号列表(1/2/3),每步一句话。不要调用任何工具,直接回答。' }],
    });
    promptAccepted = r.ok && r.value?.accepted === true;
  }, 800);
});

// 等 turn/end(≤3 分钟)
const deadline = Date.now() + 180_000;
while (!turnEnded && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
}
ws.close();

findings.otherEventTypes = [...findings.otherEventTypes];
findings.promptAccepted = promptAccepted;
findings.turnEnded = turnEnded;
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, JSON.stringify(findings, null, 2), 'utf8');

console.log('== chunk 帧结构实测 ==');
console.log('promptAccepted:', promptAccepted, '| turnEnded:', turnEnded);
console.log('事件类型:', findings.otherEventTypes.join(', '));
for (const s of findings.chunkSamples) {
  console.log('--- chunk sample: dataKeys =', s.dataKeys.join(','));
  console.log(JSON.stringify(s.data).slice(0, 500));
}
for (const s of findings.toolSamples) {
  console.log('--- tool/call sample:', JSON.stringify(s.data).slice(0, 300));
}
console.log(`已写入 ${OUT}`);
