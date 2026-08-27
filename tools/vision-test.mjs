#!/usr/bin/env node
/**
 * Indify v2 视觉实测(实施首日必跑):验证 Builder 会话模型(DSH 自带,当前 deepseek-v4-pro)
 * 是否真的能「看到」session.prompt 的 image 部件。
 *
 * 做法:
 *   1. 纯 Node 生成一张几何测试图 PNG(无第三方依赖):左红右蓝背景 + 白圆 + 绿方块;
 *   2. session.create(cwd=工作区)→ session.prompt(content = [text, {type:"image",...}]);
 *   3. 轮询 session.history 等 turn/end,取最后一条 assistant 文本;
 *   4. 把「模型是否描述了图内形状/颜色」写入 generated/v2/vision-test.json。
 *
 * 用法: node tools/vision-test.mjs
 * 说明: 若模型不吃图(回答「无法看图/纯文本」或完全胡编),结论 json 中 vision:false ——
 *       Indify v2 决策已拍板:此时先暂停 F1 多模态路径并回报用户,不擅自降级。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3080';
const CWD = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(CWD, 'generated', 'v2');
const OUT_FILE = join(OUT_DIR, 'vision-test.json');

/* ---------- 纯 Node PNG 生成(320x200,红蓝背景 + 白圆 + 绿方块) ---------- */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makeTestPng() {
  const W = 320, H = 200;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let off = 0;
  for (let y = 0; y < H; y++) {
    raw[off++] = 0; // filter none
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      const leftHalf = x < W / 2;
      r = leftHalf ? 220 : 30;
      b = leftHalf ? 40 : 180;
      g = leftHalf ? 40 : 80;
      // 白色圆(圆心 110,100,半径 55)
      const dx = x - 110, dy = y - 100;
      if (dx * dx + dy * dy <= 55 * 55) { r = 245; g = 245; b = 245; }
      // 绿色方块(右下角 250..305, y 140..190)
      if (x >= 250 && x <= 305 && y >= 140 && y <= 190) { r = 30; g = 190; b = 60; }
      raw[off++] = r; raw[off++] = g; raw[off++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- DSH /api 客户端(最小) ---------- */
async function rpc(method, payload, timeoutMs = 30000) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  const body = await res.json();
  if (!body.result?.ok) throw new Error(`${method} 失败: ${JSON.stringify(body.result?.error ?? body)}`);
  return body.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const png = makeTestPng();
  const pngFile = join(OUT_DIR, 'vision-test.png');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(pngFile, png);

  const findings = { at: new Date().toISOString(), baseUrl: BASE, imageFile: pngFile, vision: false, modelInfo: null, rawAnswer: '', judge: '' };

  // 1) 会话模型信息
  try {
    const created = await rpc('session.create', { cwd: CWD });
    findings.sessionId = created.sessionId;
    try {
      findings.modelInfo = await rpc('session.models', { sessionId: created.sessionId });
    } catch (e) {
      findings.modelInfoError = String(e);
    }
  } catch (e) {
    findings.error = String(e);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(findings, null, 2), 'utf8');
    console.log('[vision-test] 会话创建失败:', e);
    process.exit(1);
  }

  // 2) 提交带 image 部件的 prompt
  const question = '请看这张图片并严格描述你实际看到的内容:背景左右两半分别是什么颜色?图中有哪些几何形状,各自是什么颜色、大致在什么位置?如果你看不到图片,请直接回答「我看不到图片」。';
  await rpc('session.prompt', {
    sessionId: findings.sessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: question },
      { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'vision-test.png' },
    ],
  });
  findings.promptAccepted = true;

  // 3) 轮询等 turn 结束(history 轮询,≤3 分钟)
  let lastTurn = -1;
  const hist0 = await rpc('session.history', { sessionId: findings.sessionId, maxMessages: 5 });
  for (const e of hist0.events ?? []) {
    if (e.event?.type === 'turn/end' && typeof e.event.data?.turn === 'number') lastTurn = Math.max(lastTurn, e.event.data.turn);
  }
  const deadline = Date.now() + 180_000;
  let sawNewTurn = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    const hist = await rpc('session.history', { sessionId: findings.sessionId, maxMessages: 5 });
    for (const e of hist.events ?? []) {
      if (e.event?.type === 'turn/end' && typeof e.event.data?.turn === 'number' && e.event.data.turn > lastTurn) {
        lastTurn = e.event.data.turn;
        sawNewTurn = true;
      }
    }
    if (sawNewTurn) break;
  }
  if (!sawNewTurn) {
    findings.timeout = true;
    findings.rawAnswer = '(等待 turn/end 超时)';
  } else {
    // 4) 取最后一条 assistant 文本
    const hist = await rpc('session.history', { sessionId: findings.sessionId, maxMessages: 40 });
    const events = (hist.events ?? []).map((e) => e.event).filter(Boolean);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== 'assistant/message') continue;
      const parts = (e.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '');
      const text = parts.join('').trim();
      if (text) {
        findings.rawAnswer = text.slice(0, 1500);
        break;
      }
    }
  }

  // 5) 判定(关键词启发 + 人工复核)
  const ans = (findings.rawAnswer ?? '').toLowerCase();
  const sawImage = /看.?不到|无法.{0,6}(查看|看到|处理|理解).{0,8}(图片|图像)|纯文本|text-only|no vision|不支持.{0,8}(图片|图像)|cannot (see|view|process|handle).{0,10}image/i;
  const mentionedShape = /圆|circle|方块|正方形|square|矩形|rectangle/;
  const mentionedColor = /红|red|蓝|blue|绿|green/;
  if (mentionedShape.test(ans) && mentionedColor.test(ans) && !sawImage.test(ans)) {
    findings.vision = true;
    findings.judge = '模型描述了图内形状与颜色,判定可看图(请人工复核 rawAnswer)。';
  } else if (sawImage.test(ans)) {
    findings.judge = '模型明确表示看不到图片 → 纯文本模型,降级风险触发(按用户拍板:先暂停并汇报)。';
  } else {
    findings.judge = '无法自动判定(未命中形状/颜色关键词,也未明确否认) → 请人工复核 rawAnswer。';
  }

  writeFileSync(OUT_FILE, JSON.stringify(findings, null, 2), 'utf8');
  console.log('== 视觉实测结论 ==');
  console.log('vision:', findings.vision);
  console.log('judge:', findings.judge);
  console.log('modelInfo:', JSON.stringify(findings.modelInfo).slice(0, 300));
  console.log('rawAnswer:', findings.rawAnswer);
  console.log(`已写入 ${OUT_FILE}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[vision-test] 失败:', e);
  process.exit(1);
});
