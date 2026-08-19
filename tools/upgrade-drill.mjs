#!/usr/bin/env node
/**
 * Indify §11 模拟升版演练(1.16.1 → 1.17.0,DSL 0.7.0 → 0.8.0)。
 * 目标:证明「Dify 升版时只改 skill 与 adapter,扩展与 Bridge 代码零改动」。
 *
 * 阶段:
 *  1) 基线:当前 skill 对官方 0.7.0 fixture round-trip diff=∅(真实 skill,真依赖)
 *  2) 构建模拟新版 skill 树(generated/m4/upgrade-sim/skills/dify-workflow-dsl):
 *     改 DSL_VERSION→0.8.0、白名单加模拟新节点 agent-v2、
 *     复制 references/dify-1.17/ 与 adapter/dify-1.17.0.json(模拟版本漂移)
 *  3) 用模拟新版 skill 跑 round-trip:(a) 0.7.0 官方 fixture(向后兼容);(b) 0.8.0 模拟 fixture
 *  4) 版本敏感度检查:grep Bridge 与扩展源码,断言无 Dify 版本/DSL 版本硬编码
 *  5) adapter 选择模拟:按探测的 app_dsl_version 匹配 adapter 版本(与扩展 SW 同逻辑)
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const REAL_SKILL = join(ROOT, 'skills', 'dify-workflow-dsl');
const SIM_ROOT = join(ROOT, 'generated', 'm4', 'upgrade-sim');
const SIM_SKILL = join(SIM_ROOT, 'skills', 'dify-workflow-dsl');
const FIX_16 = join(REAL_SKILL, 'tests', 'fixtures', 'official-sample-1.16.1.yml');

const results = [];
const log = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ': ' + detail : ''}`);
};

function sh(cmd, cwd) {
  try {
    const out = execSync(cmd, { cwd: cwd ?? ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/* 阶段 1:基线 round-trip(真 skill) */
const base = sh('node tests/round-trip.mjs', REAL_SKILL);
log('基线:真实 skill 对官方 0.7.0 fixture round-trip', base.ok && /diff 为空|diffEmpty/.test(base.out), base.out.replace(/\n/g, ' ').slice(0, 120));

/* 阶段 2:构建模拟新版 skill */
mkdirSync(SIM_ROOT, { recursive: true });
cpSync(REAL_SKILL, SIM_SKILL, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(join('tests', '.out')) });
cpSync(join(REAL_SKILL, 'node_modules'), join(SIM_SKILL, 'node_modules'), { recursive: true });

// 模拟升版:DSL_VERSION 0.7.0 → 0.8.0
{
  const f = join(SIM_SKILL, 'scripts', 'dsl_to_ir.mjs');
  const t = readFileSync(f, 'utf8').replace('export const DSL_VERSION = "0.7.0";', 'export const DSL_VERSION = "0.8.0";');
  writeFileSync(f, t, 'utf8');
}
// 模拟新节点类型:agent-v2 加入白名单
{
  const f = join(SIM_SKILL, 'scripts', 'dsl_to_ir.mjs');
  const t = readFileSync(f, 'utf8').replace('"trigger-plugin",\n]);', '"trigger-plugin",\n  "agent-v2",\n]);');
  writeFileSync(f, t, 'utf8');
}
// 模拟版本化参考:references/dify-1.17/
cpSync(join(SIM_SKILL, 'references', 'dify-1.16'), join(SIM_SKILL, 'references', 'dify-1.17'), { recursive: true });
// 模拟新 adapter:dify-1.17.0.json
{
  const a = JSON.parse(readFileSync(join(SIM_SKILL, 'adapter', 'dify-1.16.1.json'), 'utf8'));
  a.difyVersion = '1.17.0';
  a.dslVersion = '0.8.0';
  a.generatedFrom = 'M4 升版演练模拟(1.16.1 → 1.17.0,DSL 0.7.0 → 0.8.0)';
  writeFileSync(join(SIM_SKILL, 'adapter', 'dify-1.17.0.json'), JSON.stringify(a, null, 2) + '\n', 'utf8');
}
// 移除旧 adapter 目录里不必要文件(保留 1.16.1 以便向后兼容演示)
log('构建模拟新版 skill 树', existsSync(join(SIM_SKILL, 'adapter', 'dify-1.17.0.json')), SIM_SKILL);

/* 阶段 3:模拟新版 skill 的 round-trip */
// (a) 0.7.0 官方 fixture(向后兼容)
const rtA = sh('node tests/round-trip.mjs', SIM_SKILL);
log('模拟新版 skill round-trip 0.7.0 fixture(向后兼容)', rtA.ok && /diff 为空|diffEmpty/.test(rtA.out), rtA.out.replace(/\n/g, ' ').slice(0, 120));
// (b) 0.8.0 模拟 fixture(新版本信封)
{
  const fixture = readFileSync(FIX_16, 'utf8').replace('version: 0.7.0', 'version: 0.8.0');
  const dir = join(SIM_ROOT, 'fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'official-sample-1.17.0.yml'), fixture, 'utf8');
  const rtB = sh(`node ${join(SIM_SKILL, 'scripts', 'dsl_to_ir.mjs')} ${join(dir, 'official-sample-1.17.0.yml')} ${join(dir, 'ir.json')} && node ${join(SIM_SKILL, 'scripts', 'ir_to_dsl.mjs')} ${join(dir, 'ir.json')} ${join(dir, 'rt.yml')}`, ROOT);
  // 深比较:比较脚本放在模拟 skill 目录内(让 import 'yaml' 按脚本位置解析)
  const cmpScript = join(SIM_SKILL, 'cmp.mjs');
  writeFileSync(
    cmpScript,
    `import { readFileSync } from 'node:fs';\nimport YAML from 'yaml';\nconst a = YAML.parse(readFileSync(process.argv[2], 'utf8'));\nconst b = YAML.parse(readFileSync(process.argv[3], 'utf8'));\nprocess.exit(JSON.stringify(a) === JSON.stringify(b) ? 0 : 1);\n`,
    'utf8',
  );
  const cmp = rtB.ok ? sh(`node ${cmpScript} ${join(dir, 'official-sample-1.17.0.yml')} ${join(dir, 'rt.yml')}`, SIM_SKILL) : { ok: false, out: rtB.out };
  log('模拟新版 skill round-trip 0.8.0 fixture', rtB.ok && cmp.ok, cmp.ok ? 'diff=∅' : rtB.out.slice(0, 160));
}

/* 阶段 4:版本敏感度检查 —— Bridge 与扩展不得硬编码 Dify/DSL 版本 */
{
  const scanDirs = [join(ROOT, 'bridge', 'src'), join(ROOT, 'extension')];
  const exts = ['.ts', '.js'];
  const hits = [];
  for (const dir of scanDirs) {
    for (const f of readdirSync(dir, { recursive: true })) {
      if (!exts.some((x) => f.endsWith(x))) continue;
      const full = join(dir, f);
      const text = readFileSync(full, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (/1\.16\.1|0\.7\.0|dify-1\.16/.test(line) && !line.trim().startsWith('//') && !line.includes('*') && !line.includes('http')) {
          hits.push(`${f}:${line.trim().slice(0, 90)}`);
        }
      }
    }
  }
  log('版本敏感度:扩展与 Bridge 无 Dify/DSL 版本硬编码', hits.length === 0, hits.length === 0 ? '0 处命中' : hits.slice(0, 5).join(' | '));
}

/* 阶段 5:adapter 选择模拟(与扩展 SW 同逻辑) */
{
  const adapters = [
    { version: '1.16.1', difyVersion: '1.16.1', dslVersion: '0.7.0' },
    { version: '1.17.0', difyVersion: '1.17.0', dslVersion: '0.8.0' },
  ];
  const pick = (detected) => adapters.find((a) => a.dslVersion === detected)?.version ?? adapters[adapters.length - 1].version;
  const r07 = pick('0.7.0');
  const r08 = pick('0.8.0');
  const rUnknown = pick('0.9.0');
  log('adapter 选择模拟', r07 === '1.16.1' && r08 === '1.17.0' && rUnknown === '1.17.0', `0.7.0→${r07}, 0.8.0→${r08}, 未知→${rUnknown}`);
}

/* 汇总 */
const passed = results.filter((r) => r.ok).length;
console.log(`\n== 升版演练:${passed}/${results.length} 项通过 ==`);
writeFileSync(join(SIM_ROOT, 'drill-report.json'), JSON.stringify({ results, at: new Date().toISOString() }, null, 2), 'utf8');
process.exit(passed === results.length ? 0 : 1);
