#!/usr/bin/env node
/**
 * bootstrap-skillcards.mjs — 从 DB dump(generated/apps-dump.json)批量反推真实技能卡,
 * 并把 tier/入出参/when_to_use 合并回 generated/skill-registry.json。
 *
 * 前置:先由 pwsh 生成 apps-dump.json:
 *   docker exec ... psql -t -A -c "SELECT json_agg(...) FROM apps a LEFT JOIN workflows w ..."
 * 用法:
 *   node tools/bootstrap-skillcards.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildSkillCard } from "../registry/generate-skillcard.mjs";

const DUMP = join("generated", "apps-dump.json");
const REGISTRY = join("generated", "skill-registry.json");
const OUT_DIR = join("registry");

if (!existsSync(DUMP)) {
  console.error(`[error] 缺 ${DUMP}(先 dump DB 应用数据)`);
  process.exit(1);
}
const dump = JSON.parse(readFileSync(DUMP, "utf8"));

const cards = [];
for (const app of dump) {
  const graph =
    app.graph && Array.isArray(app.graph.nodes)
      ? app.graph
      : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const dsl = {
    app: { name: app.name, description: app.description || "", mode: app.mode || "workflow" },
    kind: "app",
    version: "0.7.0",
    workflow: {
      graph,
      features: app.features || {},
      environment_variables: Array.isArray(app.env) ? app.env : [],
      conversation_variables: [],
    },
  };
  const card = buildSkillCard(dsl, { app_id: app.id, fallbackName: app.name });
  cards.push(card);
}

// 写技能卡文件
mkdirSync(OUT_DIR, { recursive: true });
for (const c of cards) {
  writeFileSync(join(OUT_DIR, `${c.id}.skillcard.json`), JSON.stringify(c, null, 2) + "\n", "utf8");
}

// 合并回注册表
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const byAppId = new Map(cards.map((c) => [c.app_id, c]));
for (const s of registry.skills) {
  const c = byAppId.get(s.id);
  if (!c) continue;
  s.skillcard = `${c.id}.skillcard.json`;
  s.whenToUse = c.when_to_use;
  s.sideEffects = c.side_effects;
  s.inputSchema = c.input_schema;
  s.outputSchema = c.output_schema;
}
writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n", "utf8");

console.log(`已生成 ${cards.length} 张技能卡,更新注册表。`);
for (const c of cards) {
  console.log(
    `  ${c.name.padEnd(32)} tier=${c.side_effects.tier.padEnd(14)} in=${Object.keys(c.input_schema).length} out=${Object.keys(c.output_schema).length}`
  );
}
