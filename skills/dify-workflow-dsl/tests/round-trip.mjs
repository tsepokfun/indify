/**
 * round-trip.mjs — DSL → IR → DSL 往返验收(全系统版本防波堤的回归闸口)。
 *
 * 用官方基准样例(由 Dify 1.16.1 运行中控制台导出的 0.7.0 DSL)做:
 *   DSL(YAML 解析) → dsl_to_ir → ir_to_dsl → DSL2
 * 然后对 DSL 与 DSL2 做结构深比较(key 顺序敏感),diff 必须为空。
 *
 * 产物:tests/.out/roundtrip-report.json(.out 已 gitignore)。
 *
 * 用法: node tests/round-trip.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { dslToIr } from "../scripts/dsl_to_ir.mjs";
import { irToDsl } from "../scripts/ir_to_dsl.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "official-sample-1.16.1.yml");
const OUT_DIR = join(__dirname, ".out");
const OUT_REPORT = join(OUT_DIR, "roundtrip-report.json");

// ---------------------------------------------------------------------------
// 深比较(key 顺序敏感)
// ---------------------------------------------------------------------------

/**
 * 深比较两个值,返回差异描述数组。
 * 差异描述:{ path, reason }。
 * 对象 key 顺序不一致也视为 diff(对应"key 顺序保持"验收)。
 */
function deepDiff(a, b, path = "$", diffs = []) {
  if (Object.is(a, b)) return diffs;

  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    diffs.push({ path, reason: `类型不一致: ${ta} vs ${tb}` });
    return diffs;
  }

  if (ta === "array") {
    if (a.length !== b.length) {
      diffs.push({ path, reason: `数组长度不一致: ${a.length} vs ${b.length}` });
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      deepDiff(a[i], b[i], `${path}[${i}]`, diffs);
    }
    return diffs;
  }

  if (ta === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    const kaSet = new Set(ka);
    const kbSet = new Set(kb);
    for (const k of ka) {
      if (!kbSet.has(k)) {
        diffs.push({ path, reason: `缺少键 "${k}"` });
      }
    }
    for (const k of kb) {
      if (!kaSet.has(k)) {
        diffs.push({ path, reason: `多出键 "${k}"` });
      }
    }
    // key 顺序检查(仅当键集合一致时逐位比对)
    if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) {
      // 顺序一致
    } else if (kaSet.size === kbSet.size && ka.every((k) => kbSet.has(k))) {
      diffs.push({
        path,
        reason: `key 顺序不一致: [${ka.join(", ")}] vs [${kb.join(", ")}]`,
      });
    }
    for (const k of ka) {
      if (kbSet.has(k)) {
        deepDiff(a[k], b[k], path === "$" ? `$${keyPath(k)}` : `${path}${keyPath(k)}`, diffs);
      }
    }
    return diffs;
  }

  // 基本类型(primitive):值不同
  diffs.push({ path, reason: `值不一致: ${JSON.stringify(a)} vs ${JSON.stringify(b)}` });
  return diffs;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}

function keyPath(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const yamlText = readFileSync(FIXTURE, "utf8");
  const dsl1 = YAML.parse(yamlText);
  const ir = dslToIr(dsl1);
  const dsl2 = irToDsl(ir);

  const diffs = deepDiff(dsl1, dsl2);
  const diffEmpty = diffs.length === 0;

  const report = {
    fixture: FIXTURE,
    generatedAt: new Date().toISOString(),
    diffEmpty,
    diffCount: diffs.length,
    diffs,
    counts: {
      nodes: dsl1?.workflow?.graph?.nodes?.length ?? 0,
      edges: dsl1?.workflow?.graph?.edges?.length ?? 0,
      irNodes: ir?.nodes?.length ?? 0,
      irEdges: ir?.edges?.length ?? 0,
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (diffEmpty) {
    console.log(`✅ round-trip diff 为空(结构深比较,key 顺序保持)`);
  } else {
    console.log(`❌ round-trip diff 非空,共 ${diffs.length} 处差异:`);
    for (const d of diffs.slice(0, 50)) {
      console.log(`  ${d.path}  ->  ${d.reason}`);
    }
    if (diffs.length > 50) console.log(`  … 其余 ${diffs.length - 50} 处见报告`);
  }
  console.log(`节点 ${report.counts.nodes} / 边 ${report.counts.edges}`);
  console.log(`报告落盘: ${resolve(OUT_REPORT)}`);
  process.exit(diffEmpty ? 0 : 1);
}

main();
