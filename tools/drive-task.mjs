#!/usr/bin/env node
/**
 * Indify 无头 E2E 驱动(v2 两段式):提交任务 → 跟 WS 帧 → plan-ready 发 build(携带最终计划文本)
 * → draft-ready 按参数 approve 或 revise → ready 拉产物。
 * 用途:M2/M3 回归、无浏览器链路验收、计划修订回路验证。
 * 用法:
 *   node tools/drive-task.mjs --spec "需求..." [--revise "反馈"] [--inject] [--out dir]
 *   node tools/drive-task.mjs --spec "..." --revise-plan "补充说明"      # 计划阶段先让 Agent 修订一轮
 *   node tools/drive-task.mjs --spec "..." --plan-edit "旧文=>新文"      # 模拟用户手改计划后构建
 *   node tools/drive-task.mjs --spec "..." --stream                      # 打印 task.stream 增量(F3)
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
const revisePlan = pick('--revise-plan');
const planEdit = pick('--plan-edit');
const inject = args.includes('--inject');
const stream = args.includes('--stream');
const outDir = pick('--out') ?? join(process.cwd(), 'generated', 'drive');
// --attach <path> 可重复:F1 附件
const attachPaths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attach' && args[i + 1]) {
    attachPaths.push(args[i + 1]);
    i += 1;
  }
}
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};
function buildAttachments() {
  return attachPaths.map((p) => {
    const data = readFileSync(p);
    const ext = p.split('.').pop().toLowerCase();
    return {
      name: p.split(/[\\/]/).pop(),
      mimeType: MIME_BY_EXT[ext] ?? '',
      size: data.length,
      dataBase64: data.toString('base64'),
    };
  });
}
if (!spec) {
  console.error('用法: node tools/drive-task.mjs --spec "需求" [--revise "反馈"] [--revise-plan "补充"] [--plan-edit "旧=>新"] [--attach 文件]* [--inject] [--stream] [--out dir]');
  process.exit(2);
}

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

async function getArtifactText(taskId, file) {
  const res = await fetch(`${BASE}/v1/artifacts/${taskId}/${file}`, { headers });
  if (!res.ok) return null;
  return res.text();
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

/* ---------- WS 订阅(task.frame / task.stream,仅用于观察) ---------- */
function connectWs(taskId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:39181/v1/events?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        close: () => {
          try { ws.close(); } catch { /* 忽略 */ }
        },
      });
    });
    ws.addEventListener('message', (ev) => {
      let f;
      try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.type === 'task.stream' && f.data && f.data.taskId === taskId) {
        if (stream) {
          if (typeof f.data.delta === 'string') process.stdout.write(f.data.delta);
          else if (f.data.tool) console.log(`\n[tool] ${f.data.tool}`);
        }
      }
    });
  });
}

const main = async () => {
  mkdirSync(outDir, { recursive: true });
  const body = { mode: 'create', spec };
  const atts = buildAttachments();
  if (atts.length > 0) {
    body.attachments = atts;
    console.log(`[drive] 附件 ${atts.length} 个: ${atts.map((a) => a.name).join(', ')}`);
  }
  const created = await http('POST', '/v1/tasks', body);
  const taskId = created.taskId;
  const { close: closeWs } = await connectWs(taskId);

  const seen = new Set();
  const frame = (d) => {
    const key = `${d.status}|${d.phase}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${key} ${d.error || d.summary || ''}`);
    }
  };
  let planRevised = false;
  let built = false;
  let structureRevised = false;
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
    if (t.status === 'plan-ready' && !built) {
      // 可选:先让 Agent 修订计划一轮
      if (revisePlan && !planRevised) {
        planRevised = true;
        console.log(`[drive] plan-ready,发 revise-plan: ${revisePlan}`);
        const planText = (await getArtifactText(taskId, 'plan.txt')) ?? '';
        await http('POST', `/v1/tasks/${taskId}/decision`, {
          action: 'revise-plan',
          feedback: `${planText}\n\n【补充说明】\n${revisePlan}`,
        });
        continue; // 等回到 plan-ready
      }
      built = true;
      // 拉取 Agent 计划,模拟用户最终计划(可手改)
      let planText = (await getArtifactText(taskId, 'plan.txt')) ?? '';
      if (planEdit) {
        const [from, to] = planEdit.split('=>');
        if (from && planText.includes(from)) {
          planText = planText.replace(from, to);
          console.log('[drive] 已应用计划手改(plan-edit)');
        } else {
          console.warn(`[drive] 警告: plan-edit 未命中原文(${from ?? ''}),以原计划构建`);
        }
      }
      writeFileSync(join(outDir, 'plan-final.txt'), planText, 'utf8');
      console.log('[drive] plan-ready,发 build(planText 长度 ' + planText.length + ')');
      await http('POST', `/v1/tasks/${taskId}/decision`, { action: 'build', planText });
    }
    if (t.status === 'draft-ready' && !decided) {
      decided = true;
      if (revise && !structureRevised) {
        structureRevised = true;
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
        const planRes = await fetch(`${BASE}/v1/artifacts/${taskId}/plan.txt`, { headers });
        if (planRes.ok) writeFileSync(join(outDir, 'plan.txt'), await planRes.text(), 'utf8');
        console.log(`[drive] 产物已落盘 ${outDir}`);
        if (inject) {
          const app = await importViaConsole(yaml);
          console.log('[drive] 导入结果:', JSON.stringify(app));
          if (app && app.app_id) {
            await http('POST', `/v1/tasks/${taskId}/injected`, { appId: app.app_id, appUrl: `http://localhost/app/${app.app_id}/workflow` });
          } else {
            console.warn('[drive] 导入未返回 app_id,任务停在 ready');
            finalStatus = 'ready';
            summary = t.summary || '';
            break;
          }
        } else {
          // 无 --inject:ready 即终点(产物已落盘)
          finalStatus = 'ready';
          summary = t.summary || '';
          break;
        }
      }
    }
  }
  closeWs();
  const result = { taskId, finalStatus, summary, outDir };
  console.log('[drive] 结果:', JSON.stringify(result));
  process.exit(finalStatus === 'done' || finalStatus === 'ready' ? 0 : 1);
};

main();
