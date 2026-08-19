#!/usr/bin/env node
/**
 * Indify 无头 E2E 驱动:提交任务 → 跟 WS 帧 → draft-ready 时按参数 approve 或 revise → ready 拉产物。
 * 用途:M2/M3 回归、无浏览器链路验收、revise 回路验证。
 * 用法:
 *   node tools/drive-task.mjs --spec "需求..." [--revise "反馈"] [--out dir]
 *   node tools/drive-task.mjs --spec "..." --approve           # 默认即 approve
 * 输出:JSON 一行 {taskId, finalStatus, summary, appId?, outDir}
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:39181';
const rc = readFileSync(join(process.cwd(), '.indifyrc.yaml'), 'utf8');
const token = rc.split(/\r?\n/).find((l) => l.startsWith('token:'))?.split(':')[1]?.trim();
if (!token) {
  console.error('未找到 .indifyrc.yaml 的 token');
  process.exit(2);
}
const headers = { 'content-type': 'application/json', 'x-indify-token': token };

const args = process.argv.slice(2);
const pick = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const spec = pick('--spec');
const revise = pick('--revise');
const inject = args.includes('--inject');
const outDir = pick('--out') ?? join(process.cwd(), 'generated', 'drive');
if (!spec) {
  console.error('用法: node tools/drive-task.mjs --spec "需求" [--revise "反馈"] [--inject] [--out dir]');
  process.exit(2);
}

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

/** 经控制台导入 API 导入 YAML(读取 generated/m0/cookies.txt 的登录态,与 content script 同路径同契约)。 */
async function importViaConsole(yamlText) {
  const jar = readFileSync(join(process.cwd(), 'generated', 'm0', 'cookies.txt'), 'utf8');
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
  const res = await fetch('http://localhost/console/api/apps/imports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'yaml-content', yaml_content: yamlText }),
  });
  const body = await res.json();
  if (res.status === 202 && body.import_id) {
    const confirm = await fetch(`http://localhost/console/api/apps/imports/${body.import_id}/confirm`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const cbody = await confirm.json();
    return { app_id: cbody.app_id ?? body.app_id, confirmed: true };
  }
  return body;
}

const main = async () => {
  mkdirSync(outDir, { recursive: true });
  const created = await http('POST', '/v1/tasks', { mode: 'create', spec });
  const taskId = created.taskId;
  const seen = new Set();
  const frame = (d) => {
    const key = `${d.status}|${d.phase}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${key} ${d.error || d.summary || ''}`);
    }
  };
  let revised = false;
  let decided = false;
  let artifactsSaved = false;
  let finalStatus = null;
  let summary = '';
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = await http('GET', `/v1/tasks/${taskId}`);
    frame(t);
    if (t.status === 'failed') {
      finalStatus = 'failed';
      break;
    }
    if (t.status === 'done') {
      finalStatus = 'done';
      summary = t.summary || '';
      break;
    }
    if (t.status === 'draft-ready' && !decided) {
      decided = true;
      if (revise && !revised) {
        revised = true;
        console.log(`[drive] draft-ready,发 revise: ${revise}`);
        await http('POST', `/v1/tasks/${taskId}/decision`, { action: 'revise', feedback: revise });
        decided = false; // 改完后会再次进入 draft-ready,届时 approve
      } else {
        console.log('[drive] draft-ready,发 approve');
        await http('POST', `/v1/tasks/${taskId}/decision`, { action: 'approve' });
      }
    }
    if (t.status === 'ready' && !artifactsSaved) {
      artifactsSaved = true;
      const yamlRes = await fetch(`${BASE}/v1/artifacts/${taskId}/workflow.yaml`, { headers });
      if (yamlRes.ok) {
        const yaml = await yamlRes.text();
        writeFileSync(join(outDir, 'workflow.yaml'), yaml, 'utf8');
        const irRes = await fetch(`${BASE}/v1/artifacts/${taskId}/ir.json`, { headers });
        if (irRes.ok) writeFileSync(join(outDir, 'ir.json'), await irRes.text(), 'utf8');
        console.log(`[drive] 产物已落盘 ${outDir}`);
        if (inject) {
          const app = await importViaConsole(yaml);
          console.log('[drive] 导入结果:', JSON.stringify(app));
          if (app && app.app_id) {
            await http('POST', `/v1/tasks/${taskId}/injected`, { appId: app.app_id, appUrl: `http://localhost/app/${app.app_id}/workflow` });
          }
        }
      }
    }
  }
  const result = { taskId, finalStatus, summary, outDir };
  console.log('[drive] 结果:', JSON.stringify(result));
  process.exit(finalStatus === 'done' ? 0 : 1);
};

main();
