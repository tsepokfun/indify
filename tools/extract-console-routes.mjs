#!/usr/bin/env node
/** 从 dify-web oRPC 契约 chunk 提取全部 route(path/method/operationId/summary),按 route({ 锚点配对,容忍嵌套对象。 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'generated', 'm0', 'contracts');
const OUT = join(process.cwd(), 'generated', 'm0', 'console-api-routes.json');

const routes = [];
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
for (const f of files) {
  const text = readFileSync(join(DIR, f), 'utf8');
  // 1) 锚点:route({
  const anchors = [];
  let ai = 0;
  while ((ai = text.indexOf('route({', ai)) !== -1) { anchors.push(ai); ai += 7; }
  if (anchors.length === 0) continue;
  // 2) 字段出现位置
  const collect = (key) => {
    const out = [];
    let i = 0;
    while ((i = text.indexOf(`${key}:"`, i)) !== -1) {
      const end = text.indexOf('"', i + key.length + 2);
      if (end !== -1) out.push({ pos: i, val: text.slice(i + key.length + 2, end) });
      i = end + 1;
    }
    return out;
  };
  const paths = collect('path');
  const methods = collect('method');
  const opIds = collect('operationId');
  const sums = collect('summary');
  const next = (list, pos) => list.find((x) => x.pos > pos);
  for (const a of anchors) {
    const p = next(paths, a);
    const m = next(methods, a);
    if (!p || !m) continue;
    const op = next(opIds, a);
    const s = next(sums, a);
    routes.push({ file: f, method: m.val, path: p.val, operationId: op?.val ?? null, summary: s?.val ?? null });
  }
}
// 去重(同 method+path)
const seen = new Set();
const uniq = routes.filter((r) => {
  const k = `${r.method} ${r.path}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
uniq.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
writeFileSync(OUT, JSON.stringify(uniq, null, 2), 'utf8');
console.log(`routes: ${routes.length} raw → ${uniq.length} unique → ${OUT}`);

// 打印工作流/应用相关核心端点
const interesting = uniq.filter((r) => /workflow|apps|app\/|import|export|draft|graph|run|dsl|site|features|conversation/i.test(r.path) && !/trial|billing|account|auth|login|logout|datasets|files\/|rag|website|installed|explore|tag|notion/.test(r.path));
for (const r of interesting) console.log(`${r.method.padEnd(6)} ${r.path.padEnd(58)} # ${r.operationId ?? ''} ${r.summary ?? ''}`);
