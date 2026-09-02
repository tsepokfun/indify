#!/usr/bin/env node
/**
 * dify-mcp — 把 Dify 工作流技能暴露成 MCP tools(stdio JSON-RPC,零第三方依赖)。
 *
 * 讓任何支援 MCP 的 agent(Claude Code / Codex / Cursor / DSH 等)都能:
 *   - list_skills  列出可用的 Dify 工作流技能(名稱/描述/副作用/輸入)
 *   - run_skill    執行一個技能(名字或 app id + 輸入變數)→ 回輸出
 *
 * 配置:mcp/config.json(見 config.example.json):{ baseUrl, appKeys: { "<appId>": "app-..." } }
 * 註冊表:generated/skill-registry.json(由 tools/bootstrap-skillcards.mjs 生成)
 *
 * MCP 協定(stdin/stdout,每行一個 JSON-RPC 2.0 訊息):
 *   initialize → result(protocolVersion/capabilities/serverInfo)
 *   notifications/initialized(不回)
 *   tools/list → result.tools
 *   tools/call → result.content[{type:"text",text}] + isError
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, "..");
const REGISTRY = join(WORKSPACE, "generated", "skill-registry.json");
const CONFIG = join(__dirname, "config.json");

/* ---------- 配置 ---------- */
let config = { baseUrl: "http://localhost", appKeys: {} };
if (existsSync(CONFIG)) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
    config = { ...config, ...raw, appKeys: { ...(raw.appKeys || {}) } };
  } catch (e) {
    process.stderr.write(`[dify-mcp] 讀不到 config.json: ${e.message}\n`);
  }
}

/* ---------- 註冊表 ---------- */
let skills = [];
if (existsSync(REGISTRY)) {
  try {
    skills = JSON.parse(readFileSync(REGISTRY, "utf8")).skills || [];
  } catch (e) {
    process.stderr.write(`[dify-mcp] 讀不到 skill-registry.json: ${e.message}\n`);
  }
}

function skillAppId(s) {
  return s && (s.appId || s.id) || "";
}

function findSkill(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  return skills.find((s) => s.name === q || s.id === q || skillAppId(s) === q) || null;
}

/* ---------- 工具定義(描述用英文,供 LLM 讀取) ---------- */
const TOOLS = [
  {
    name: "list_skills",
    description:
      "List all Dify workflow skills available to run. Each skill is a Dify workflow with a name, " +
      "description, input schema and a side-effect tier (none/read/write/external_send/irreversible). " +
      "Use this to discover which skill fits a task before calling run_skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_skill",
    description:
      "Run a Dify workflow skill. `skill` is the skill name or its app id (see list_skills). " +
      "`inputs` is a JSON object of the workflow start-node input variables. " +
      "Runs the published version via the Dify Service API and returns the outputs.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name or app id" },
        inputs: { type: "object", description: "Workflow start-node input variables as a JSON object" },
      },
      required: ["skill"],
    },
  },
];

/* ---------- Service API 執行 ---------- */
async function runWorkflow(appId, inputs) {
  const key = (config.appKeys || {})[appId];
  if (!key) {
    return {
      ok: false,
      error:
        `缺少 app "${appId}" 的 API key。請在 Dify 控制台 App → API 訪問 建立一支 app key,` +
        `再寫入 mcp/config.json 的 appKeys 對應項。`,
    };
  }
  let res;
  try {
    res = await fetch(`${config.baseUrl}/v1/workflows/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ inputs: inputs || {}, user: "mcp-agent", response_mode: "blocking" }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return { ok: false, error: `呼叫 Service API 失敗: ${e && e.message || e}` };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${res.status}: ${body && (body.error || body.message) || "unknown"}`,
    };
  }
  const data = body && body.data;
  return {
    ok: !!(data && data.status === "succeeded" && !data.error),
    status: data && data.status,
    outputs: data ? data.outputs : undefined,
    error: data ? data.error : undefined,
    elapsed_time: data ? data.elapsed_time : undefined,
    workflow_run_id: body && body.workflow_run_id,
  };
}

/* ---------- 工具呼叫 ---------- */
async function handleToolCall(name, args) {
  if (name === "list_skills") {
    if (!Array.isArray(skills) || skills.length === 0) {
      return { text: "(無技能;請先執行 node tools/bootstrap-skillcards.mjs 生成技能卡)", isError: false };
    }
    const lines = skills.map((s) => {
      const tier = (s.sideEffects && s.sideEffects.tier) || "?";
      const ins = Object.keys(s.inputSchema || {}).join(", ");
      return `- ${s.name}  [app:${skillAppId(s)}]  tier=${tier}${ins ? `  輸入:${ins}` : ""}\n    ${s.description || ""}`;
    });
    return { text: lines.join("\n"), isError: false };
  }

  if (name === "run_skill") {
    const skill = findSkill(args && args.skill);
    if (!skill) {
      return { text: `找不到技能 "${args && args.skill}"。請先用 list_skills 查看可用技能。`, isError: true };
    }
    const appId = skillAppId(skill);
    const tier = (skill.sideEffects && skill.sideEffects.tier) || "none";
    if (tier === "external_send" || tier === "irreversible" || tier === "write") {
      process.stderr.write(`[dify-mcp] 提醒:技能「${skill.name}」副作用 tier=${tier},執行前應先經用戶確認。\n`);
    }
    const r = await runWorkflow(appId, (args && args.inputs) || {});
    if (!r.ok) {
      return { text: `運行「${skill.name}」失敗: ${r.error || `status=${r.status}`}`, isError: true };
    }
    const out = typeof r.outputs === "string" ? r.outputs : JSON.stringify(r.outputs, null, 2);
    return { text: `運行「${skill.name}」成功(status=${r.status}, 耗時 ${r.elapsed_time ?? "?"}s)\noutputs:\n${out}`, isError: false };
  }

  return { text: `未知工具: ${name}`, isError: true };
}

/* ---------- JSON-RPC over stdio ---------- */
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 忽略非 JSON 行
  }
  if (!msg || typeof msg.method !== "string") return;

  if (msg.method === "initialize") {
    const pv = msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : "2024-11-05";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: pv,
        capabilities: { tools: {} },
        serverInfo: { name: "dify-mcp", version: "0.1.0" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
    return; // 通知,不回
  }

  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = (msg.params || {});
    handleToolCall(name, args)
      .then((r) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: r.text }], isError: r.isError === true },
        });
      })
      .catch((e) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: String((e && e.message) || e) }],
            isError: true,
          },
        });
      });
    return;
  }

  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
});

// stdin 結束時不要立刻 exit;讓 pending 的 async tool call(fetch)完成後自然退出。
rl.on("close", () => {
  /* no-op:事件迴圈空了自然退出 */
});
