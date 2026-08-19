#!/usr/bin/env node
/** 模拟 content script 的 injectModify:GET 最新草稿(fresh hash)→ POST 写回 graph.json 的新 graph。 */
import { readFileSync, writeFileSync } from 'node:fs';

const APP_ID = process.argv[2];
const GRAPH_FILE = process.argv[3];
const OUT = process.argv[4] ?? 'generated/m0/injectmodify-resp.json';

const jar = readFileSync('generated/m0/cookies.txt', 'utf8');
const cookies = {};
for (const line of jar.split(/\r?\n/)) {
  const l = line.replace(/^#HttpOnly_/, '').trim();
  if (!l || l.startsWith('#')) continue;
  const p = l.split('\t');
  if (p.length >= 7 && p[5]) cookies[p[5]] = p[6];
}
const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const headers = { 'content-type': 'application/json', cookie: cookieHeader };
if (cookies['csrf_token']) headers['x-csrf-token'] = cookies['csrf_token'];

const base = 'http://localhost/console/api';

// 1) 最新草稿(fresh hash)
const draftRes = await fetch(`${base}/apps/${APP_ID}/workflows/draft`, { headers });
const draft = await draftRes.json();

// 2) 写回新 graph
const graph = JSON.parse(readFileSync(GRAPH_FILE, 'utf8'));
const postRes = await fetch(`${base}/apps/${APP_ID}/workflows/draft`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    graph,
    features: draft.features,
    hash: draft.hash,
    environment_variables: draft.environment_variables ?? [],
    conversation_variables: draft.conversation_variables ?? [],
  }),
});
const resp = await postRes.json();
writeFileSync(OUT, JSON.stringify({ httpStatus: postRes.status, body: resp }, null, 2), 'utf8');
console.log('draft 写回:', postRes.status, JSON.stringify(resp).slice(0, 160));
