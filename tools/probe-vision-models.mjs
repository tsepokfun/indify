#!/usr/bin/env node
/**
 * 视觉实测补充探查:列出 session.models 目录 + session.list 当前会话 preset,
 * 判断 DSH 环境内是否存在任何可选的视觉模型(供用户决策,不自动切换)。
 */
const BASE = 'http://127.0.0.1:3080';
const CWD = 'D:\\difyIndify';

async function rpc(method, payload, timeoutMs = 30000) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  const body = await res.json();
  return body.result;
}

const created = await rpc('session.create', { cwd: CWD });
if (!created.ok) throw new Error('session.create 失败: ' + JSON.stringify(created.error));
const sessionId = created.value.sessionId;
console.log('sessionId:', sessionId);

const models = await rpc('session.models', { sessionId });
console.log('session.models result.ok =', models.ok);
if (models.ok) {
  const v = models.value;
  console.log('current:', JSON.stringify(v.current));
  console.log('routable:', v.routable);
  for (const g of v.groups ?? []) {
    console.log(`provider=${g.id} name=${g.name} models=[${(g.models ?? []).map((m) => `${m.id}${(m.reasoning ? '(reasoning)' : '')}`).join(', ')}]`);
  }
  for (const f of v.failures ?? []) console.log(`failure: ${f.id} ${f.message}`);
} else {
  console.log('session.models error:', JSON.stringify(models.error));
}

const list = await rpc('session.list', {});
if (list.ok) {
  for (const it of list.value.items ?? []) {
    console.log(`session: ${it.sessionId} preset=${JSON.stringify(it.agentPreset)} blank=${it.blank} running=${it.running}`);
  }
}
