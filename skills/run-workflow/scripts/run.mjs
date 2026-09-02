/**
 * run.mjs — 运行已发布的 Dify 1.16.1 workflow(Service API 执行侧)。
 *
 * 职责(Indify v3 执行侧「手」):
 *   - 把「已发布的 workflow」当技能跑:POST /v1/workflows/run,返回归一化结果。
 *   - blocking:同步拿 end 节点 outputs,归一化为 {ok, task_id, workflow_run_id,
 *     status, outputs, error, elapsed_time, total_tokens, total_steps}。
 *   - streaming:消费 SSE,把 workflow_started/node_started/node_finished/
 *     workflow_finished/error 事件逐行转发到 stdout(JSON 行)。
 *   - 零第三方依赖:只用 Node 22 全局 fetch。
 *
 * 用法:
 *   node run.mjs --app-id <id> --inputs '<json>' [--api-key <key>] [--user <u>]
 *        [--response-mode blocking|streaming] [--timeout-ms N] [--base-url <url>]
 *
 * 默认:base-url=http://localhost, user=indify, response-mode=blocking,
 *       timeout-ms=60000。
 *
 * API key 解析顺序:--api-key > 环境变量 DIFY_APP_API_KEY;缺失即报错退出(非 0)。
 * 全程不回显 key。
 *
 * 退出码:0 = 成功(blocking: 2xx 且 status==='succeeded';streaming: 最后一个
 *        workflow_finished.status==='succeeded');非 0 = 失败/出错。
 */

import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 常量与默认值
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost";
const DEFAULT_USER = "indify";
const DEFAULT_RESPONSE_MODE = "blocking";
const DEFAULT_TIMEOUT_MS = 60_000;
const RUN_PATH = "/v1/workflows/run";

/** streaming 模式下转发到 stdout 的事件白名单。 */
const STREAM_FORWARD_EVENTS = new Set([
  "workflow_started",
  "node_started",
  "node_finished",
  "workflow_finished",
  "error",
]);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fail(msg, exitCode = 1) {
  // 网络/超时/非 2xx 等运行时错误:归一化 JSON 到 stdout,退出码非 0。
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(exitCode);
}

function usageError(msg) {
  // 用法/配置错误:清晰中文说明到 stderr,退出码 2。
  console.error(msg);
  console.error(
    "用法: node run.mjs --app-id <id> --inputs '<json>' [--api-key <key>] [--user <u>] " +
      "[--response-mode blocking|streaming] [--timeout-ms N] [--base-url <url>]"
  );
  process.exit(2);
}

function missingKeyError() {
  // 缺失 key:说明从哪生成、什么前缀,绝不含任何 key 值。
  console.error(
    "错误:缺少 Dify 应用 API key。\n" +
      "  - 用 --api-key <key> 传入,或设置环境变量 DIFY_APP_API_KEY。\n" +
      "  - key 在 Dify 控制台:进入对应 App → 左侧「API 访问 / API Access」→ 创建/复制。\n" +
      "  - key 以 'app-' 为前缀(形如 app-xxxxxxxxxxxxxxxxxxxxxxxx)。\n" +
      "  - 本脚本绝不会在输出里回显 key 本身。"
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    user: DEFAULT_USER,
    responseMode: DEFAULT_RESPONSE_MODE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    appId: undefined,
    inputs: undefined,
    apiKey: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usageError(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case "--app-id": opts.appId = next(); break;
      case "--inputs": opts.inputs = next(); break;
      case "--api-key": opts.apiKey = next(); break;
      case "--user": opts.user = next(); break;
      case "--response-mode": opts.responseMode = next(); break;
      case "--timeout-ms": opts.timeoutMs = Number(next()); break;
      case "--base-url": opts.baseUrl = next(); break;
      case "--help":
      case "-h":
        console.log(
          "用法: node run.mjs --app-id <id> --inputs '<json>' [--api-key <key>] [--user <u>] " +
            "[--response-mode blocking|streaming] [--timeout-ms N] [--base-url <url>]"
        );
        process.exit(0);
      default:
        usageError(`未知参数:${a}`);
    }
  }

  // 必填项校验
  if (!opts.appId || typeof opts.appId !== "string") {
    usageError("错误:--app-id 必填(workflow 应用的 app_id)。");
  }
  if (opts.inputs === undefined) {
    usageError("错误:--inputs 必填(workflow 输入变量的 JSON,如 '{}' 或 '{\"query\":\"hi\"}')。");
  }

  // inputs 必须是合法 JSON 对象
  let inputs;
  try {
    inputs = JSON.parse(opts.inputs);
  } catch {
    usageError(`错误:--inputs 不是合法 JSON:${opts.inputs}`);
  }
  if (!isPlainObject(inputs)) {
    usageError("错误:--inputs 解析后必须是 JSON 对象(如 {} 或 {\"key\":\"value\"})。");
  }
  opts.inputs = inputs;

  // response-mode 白名单
  if (opts.responseMode !== "blocking" && opts.responseMode !== "streaming") {
    usageError(`错误:--response-mode 只能是 blocking 或 streaming,收到:${opts.responseMode}`);
  }

  // timeout 必须是正数
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    usageError(`错误:--timeout-ms 必须是正整数(毫秒),收到:${opts.timeoutMs}`);
  }

  // base-url 去尾斜杠
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");

  return opts;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** blocking 响应体 → 归一化结果。 */
function normalizeBlocking(payload, httpStatus) {
  const data = isPlainObject(payload?.data) ? payload.data : {};
  const status = data.status ?? null;
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  return {
    ok: httpOk && status === "succeeded",
    task_id: payload?.task_id ?? null,
    workflow_run_id: payload?.workflow_run_id ?? null,
    status,
    outputs: data.outputs ?? null,
    error: data.error ?? null,
    elapsed_time: data.elapsed_time ?? null,
    total_tokens: data.total_tokens ?? null,
    total_steps: data.total_steps ?? null,
  };
}

/** 非 2xx 响应体 → 可读错误消息(Dify 错误形如 {code, message, status})。 */
function httpErrorToMessage(httpStatus, bodyText) {
  let code;
  let message;
  try {
    const j = JSON.parse(bodyText);
    code = j?.code;
    message = j?.message;
  } catch {
    // 非 JSON 响应体,忽略。
  }
  if (message) return `HTTP ${httpStatus}: ${message}${code ? ` (${code})` : ""}`;
  const snippet = bodyText ? bodyText.slice(0, 200) : "";
  return `HTTP ${httpStatus}${snippet ? `: ${snippet}` : ""}`;
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

function buildRequest(opts) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
  };
  const body = {
    inputs: opts.inputs,
    user: opts.user,
    response_mode: opts.responseMode,
  };
  return {
    url: `${opts.baseUrl}${RUN_PATH}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    },
  };
}

async function doFetch(opts) {
  const { url, init } = buildRequest(opts);
  try {
    return await fetch(url, init);
  } catch (err) {
    const name = err?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      fail(`请求超时(>${opts.timeoutMs}ms):${url}`);
    }
    fail(`网络错误:${err?.message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// blocking
// ---------------------------------------------------------------------------

async function runBlocking(opts) {
  const resp = await doFetch(opts);
  const bodyText = await resp.text();
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    fail(`响应体不是 JSON(HTTP ${resp.status}):${bodyText.slice(0, 200)}`);
  }
  if (!(resp.status >= 200 && resp.status < 300)) {
    fail(httpErrorToMessage(resp.status, bodyText));
  }
  const result = normalizeBlocking(payload, resp.status);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// streaming(SSE 消费)
// ---------------------------------------------------------------------------

/** 解析单个 SSE 帧(data: {JSON}\n\n),返回 data 载荷字符串或 null。 */
function parseSseFrame(frame) {
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

async function runStreaming(opts) {
  const resp = await doFetch(opts);

  if (!(resp.status >= 200 && resp.status < 300)) {
    const bodyText = await resp.text();
    fail(httpErrorToMessage(resp.status, bodyText));
  }

  let lastWorkflowStatus = null;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = resp.body.getReader();

  const onFrame = (frame) => {
    const dataStr = parseSseFrame(frame);
    if (dataStr === null || dataStr === "") return; // ping / 空帧
    let ev;
    try {
      ev = JSON.parse(dataStr);
    } catch {
      return; // 非法 JSON,忽略
    }
    if (!ev || typeof ev.event !== "string") return;
    if (ev.event === "workflow_finished") {
      lastWorkflowStatus = ev?.data?.status ?? null;
    }
    if (STREAM_FORWARD_EVENTS.has(ev.event)) {
      console.log(JSON.stringify(ev));
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        onFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) onFrame(buffer);
  } catch (err) {
    fail(`流读取错误:${err?.message ?? String(err)}`);
  }

  process.exit(lastWorkflowStatus === "succeeded" ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // key 解析顺序:--api-key > 环境变量 DIFY_APP_API_KEY(不回显)。
  opts.apiKey = opts.apiKey ?? process.env.DIFY_APP_API_KEY;
  if (!opts.apiKey) missingKeyError();

  if (opts.responseMode === "streaming") {
    await runStreaming(opts);
  } else {
    await runBlocking(opts);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
