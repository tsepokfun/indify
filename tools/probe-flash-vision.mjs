#!/usr/bin/env node
/**
 * 探查 deepseek-v4-flash 是否支持 image 输入(throwaway 会话,不影响任何正式会话)。
 * 结论写 generated/v2/flash-vision-probe.json。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3080';
const CWD = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(CWD, 'generated', 'v2', 'flash-vision-probe.json');

function crc32(buf) {
  let t = crc32.table;
  if (!t) {
    t = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng() {
  const W = 160, H = 100;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let off = 0;
  for (let y = 0; y < H; y++) {
    raw[off++] = 0;
    for (let x = 0; x < W; x++) {
      let r = 250, g = 200, b = 40; // 黄底
      if ((x - 60) * (x - 60) + (y - 50) * (y - 50) <= 30 * 30) { r = 20; g = 20; b = 120; } // 蓝色圆
      raw[off++] = r; raw[off++] = g; raw[off++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = { at: new Date().toISOString(), steps: [] };
const created = await rpc('session.create', { cwd: CWD });
if (!created.ok) throw new Error('create: ' + JSON.stringify(created.error));
const sessionId = created.value.sessionId;
findings.sessionId = sessionId;
findings.steps.push('session.create ok');

const sel = await rpc('session.selectModel', {
  sessionId,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
});
findings.steps.push({ 'session.selectModel(flash)': sel.ok ? 'ok' : JSON.stringify(sel.error) });

const png = makePng();
const promptRes = await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [
    { type: 'text', text: '请看图片:背景是什么颜色?图里有什么形状、什么颜色?看不到图就直说「我看不到图片」。' },
    { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'flash-probe.png' },
  ],
});
findings.steps.push({ 'session.prompt(image)': promptRes.ok ? 'accepted' : JSON.stringify(promptRes.error) });
if (!promptRes.ok) {
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(findings, null, 2), 'utf8');
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

// 等 turn/end 后取最后 assistant 文本
let lastTurn = -1;
let saw = false;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline && !saw) {
  await sleep(3000);
  const hist = await rpc('session.history', { sessionId, maxMessages: 5 });
  for (const e of hist.value?.events ?? []) {
    if (e.event?.type === 'turn/end' && typeof e.event.data?.turn === 'number' && e.event.data.turn > lastTurn) {
      lastTurn = e.event.data.turn; saw = true;
    }
  }
}
if (saw) {
  const hist = await rpc('session.history', { sessionId, maxMessages: 40 });
  const events = (hist.value?.events ?? []).map((e) => e.event).filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'assistant/message') continue;
    const text = (events[i].data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('').trim();
    if (text) { findings.rawAnswer = text.slice(0, 1200); break; }
  }
}
findings.vision = /圆|circle|蓝|blue|黄|yellow/.test(findings.rawAnswer ?? '');
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, JSON.stringify(findings, null, 2), 'utf8');
console.log(JSON.stringify(findings, null, 2));
