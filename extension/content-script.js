// Indify content script — M3(就地修改 U2 + 续聊 U3)
// 注入 http://localhost/*(Dify 控制台):
//   1. 识别当前 app 上下文(appId / appName / mode / page / url)
//   2. 上报给 service worker({type:"indify:context"})
//   3. 响应 SW 的 ping / getContext
//   4. create:执行 DSL 导入(indify:injectCreate,route B)
//   5. modify:读草稿(indify:getDraft)+ 写回草稿(indify:injectModify)
//   6. run:发布草稿 + 取/建 app key + Service API 运行(indify:runWorkflow,S3)
//
// 页面分类:
//   - /app/{uuid}/workflow → page:"workflow",mode:"workflow"
//   - /apps                → page:"apps"(应用列表)
//   - /app/{uuid}/其它页    → page:"other"(仍提取 appId)
//   - 其余                → page:"other"

function extractAppName() {
  const title = (document.title || "").trim();
  if (!title) return undefined;
  const cleaned = title
    .replace(/\s*[-–—·|]\s*(Dify(?: · 开源)?|Dify Console).*$/i, "")
    .trim();
  return cleaned || undefined;
}

function detectContext() {
  const url = location.href;
  const path = location.pathname;

  const ctx = { url, page: "other" };

  const appMatch = path.match(/^\/app\/([0-9a-fA-F-]{8,})/);
  if (appMatch) ctx.appId = appMatch[1];

  if (/^\/apps(\/|$)/.test(path)) {
    ctx.page = "apps";
  } else if (ctx.appId && /\/workflow(\/|$)/.test(path)) {
    ctx.page = "workflow";
    ctx.mode = "workflow";
  } else if (ctx.appId) {
    ctx.page = "other";
  } else {
    ctx.page = "other";
  }

  if (ctx.appId) ctx.appName = extractAppName();

  return ctx;
}

function reportContext() {
  try {
    chrome.runtime
      .sendMessage({ type: "indify:context", context: detectContext() })
      .catch(() => {});
  } catch (e) {
    /* 忽略 */
  }
}

// ---------- 通用 HTTP 工具 ----------
function readCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function buildHeaders(adapter) {
  const c = (adapter && adapter.console) || {};
  const csrfHeader = (c.csrf && c.csrf.headerName) || "X-CSRF-Token";
  const headers = { "Content-Type": "application/json" };
  const token = readCsrfToken();
  if (token) headers[csrfHeader] = token;
  return headers;
}

async function safeJson(res) {
  const t = await res.text().catch(() => "");
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return { __raw: t };
  }
}

function extractAppId(body) {
  if (!body) return undefined;
  return (
    body.app_id ||
    body.appId ||
    (body.data && (body.data.app_id || body.data.appId))
  );
}

function consoleUrl(adapter, pathWithPlaceholder, appId) {
  const c = (adapter && adapter.console) || {};
  const base = c.baseUrl || "http://localhost";
  const apiPrefix = c.apiPrefix || "/console/api";
  const p = (pathWithPlaceholder || "").replace("{app_id}", appId || "");
  return base + apiPrefix + p;
}

// ---------- create:DSL 导入(route B) ----------
// 执行控制台导入:POST /apps/imports(202 时 confirm)。返回 {ok, appId?, error?}
async function injectCreate(yamlText, adapter) {
  if (!yamlText) return { ok: false, error: "yamlText 为空" };
  if (!adapter || !adapter.console) return { ok: false, error: "adapter 缺失 console 配置" };

  const importCfg = adapter.console.endpoints && adapter.console.endpoints.importDsl;
  const confirmCfg = adapter.console.endpoints && adapter.console.endpoints.importConfirm;
  if (!importCfg) return { ok: false, error: "adapter 缺少 importDsl 端点" };

  const importUrl = consoleUrl(adapter, importCfg.path || "/apps/imports");
  const headers = buildHeaders(adapter);

  // 1) 提交导入
  let res;
  try {
    res = await fetch(importUrl, {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({ mode: "yaml-content", yaml_content: yamlText }),
    });
  } catch (e) {
    return { ok: false, error: "导入 fetch 失败:" + ((e && e.message) || e) };
  }

  // 2) 同步完成
  if (res.status === 200) {
    const body = await safeJson(res);
    return { ok: true, appId: extractAppId(body), status: body && body.status };
  }

  // 3) 202 pending → confirm
  if (res.status === 202) {
    const body = await safeJson(res);
    const importId = body && body.import_id;
    if (!importId) return { ok: false, error: "202 响应缺少 import_id" };

    const confirmUrl = consoleUrl(
      adapter,
      (confirmCfg && confirmCfg.path) || "/apps/imports/{import_id}/confirm",
      null
    ).replace("{import_id}", importId);

    let cRes;
    try {
      cRes = await fetch(confirmUrl, {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: "{}",
      });
    } catch (e) {
      return { ok: false, error: "confirm fetch 失败:" + ((e && e.message) || e) };
    }

    if (cRes.status === 200) {
      const cBody = await safeJson(cRes);
      return {
        ok: true,
        appId: extractAppId(cBody) || extractAppId(body),
        status: cBody && cBody.status,
      };
    }
    const cBody = await safeJson(cRes);
    return {
      ok: false,
      error:
        "confirm 失败(HTTP " +
        cRes.status +
        "):" +
        ((cBody && (cBody.error || cBody.message)) || ""),
    };
  }

  // 4) 其它失败
  const body = await safeJson(res);
  return {
    ok: false,
    error:
      (body && (body.error || body.message)) || "导入失败(HTTP " + res.status + ")",
  };
}

// ---------- modify:读/写草稿(就地更新) ----------
function draftPath(adapter) {
  const cfg =
    adapter &&
    adapter.console &&
    adapter.console.endpoints &&
    adapter.console.endpoints.draftGet;
  return (cfg && cfg.path) || "/apps/{app_id}/workflows/draft";
}

// 读草稿:GET /apps/{app_id}/workflows/draft(CSRF 豁免,顺手带 token 无妨)
async function getDraft(appId, adapter) {
  if (!appId) return { ok: false, error: "缺少 appId" };
  if (!adapter || !adapter.console) return { ok: false, error: "adapter 缺失" };

  const url = consoleUrl(adapter, draftPath(adapter), appId);
  const headers = buildHeaders(adapter);
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
  } catch (e) {
    return { ok: false, error: "读取草稿失败:" + ((e && e.message) || e) };
  }
  if (res.status !== 200) {
    const body = await safeJson(res);
    return {
      ok: false,
      status: res.status,
      error:
        "读取草稿失败(HTTP " +
        res.status +
        "):" +
        ((body && (body.error || body.message)) || ""),
    };
  }
  const draft = await safeJson(res);
  return { ok: true, draft };
}

// 写回草稿:先 GET 最新草稿(拿最新 hash/features 避免乐观锁冲突)→ POST
async function injectModify(appId, graphText, adapter) {
  if (!appId) return { ok: false, error: "缺少 appId" };
  if (!graphText) return { ok: false, error: "graphText 为空" };
  if (!adapter || !adapter.console) return { ok: false, error: "adapter 缺失" };

  let graph;
  try {
    graph = JSON.parse(graphText);
  } catch (e) {
    return { ok: false, error: "graph.json 解析失败:" + ((e && e.message) || e) };
  }

  // 1) 先 GET 最新草稿,拿最新 hash/features/env 变量
  const g = await getDraft(appId, adapter);
  if (!g.ok) return g;
  const draft = g.draft || {};

  const postCfg =
    adapter.console.endpoints && adapter.console.endpoints.draftPost;
  const postUrl = consoleUrl(
    adapter,
    (postCfg && postCfg.path) || draftPath(adapter),
    appId
  );

  const body = {
    graph,
    features: draft.features || {},
    hash: draft.hash || null,
    environment_variables: draft.environment_variables || [],
    conversation_variables: draft.conversation_variables || [],
  };

  const headers = buildHeaders(adapter);
  let res;
  try {
    res = await fetch(postUrl, {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "写回草稿失败:" + ((e && e.message) || e) };
  }

  if (res.status === 200) {
    const respBody = await safeJson(res);
    return { ok: true, hash: respBody && respBody.hash, result: respBody };
  }

  const respBody = await safeJson(res);
  const msg = respBody && (respBody.error || respBody.message);
  // 409/400 视为可重试失败(409=乐观锁 hash 冲突,提示重试)
  return {
    ok: false,
    status: res.status,
    error:
      "写回草稿失败(HTTP " + res.status + "):" + (msg || "") +
      (res.status === 409 ? "(草稿已被其它操作修改,请重试)" : ""),
  };
}

// ---------- run:发布草稿 + 取/建 app key + Service API 执行(S3) ----------

// 纯函数:判定一次运行是否成功(供 S5 闭环复用)
function isRunSuccess(data) {
  return !!(data && data.status === "succeeded" && !data.error);
}

const APP_KEY_PREFIX = "appKey:";

async function readStoredAppKey(appId) {
  try {
    const key = APP_KEY_PREFIX + appId;
    const data = await chrome.storage.local.get(key);
    return (data && data[key]) || "";
  } catch (e) {
    return "";
  }
}

async function persistAppKey(appId, token) {
  try {
    await chrome.storage.local.set({ [APP_KEY_PREFIX + appId]: token });
  } catch (e) {
    /* 忽略:最坏下次重建 key */
  }
}

// 取 app API key:优先复用已持久化 token → 否则 GET list 找明文 token → 否则 POST create。
// ⚠ token 一次性可见,必须在 create 当下持久化;list 通常不回传明文。
async function obtainAppKey(appId, adapter) {
  const ep = adapter && adapter.console && adapter.console.endpoints;
  const listCfg = ep && ep.listApiKeys;
  const createCfg = ep && ep.createApiKey;
  const headers = buildHeaders(adapter);

  // 1) 已持久化的 key 直接复用
  const stored = await readStoredAppKey(appId);
  if (stored) return stored;

  // 2) GET list:若列表项含 token 明文则复用并持久化
  if (listCfg) {
    const listUrl = consoleUrl(adapter, listCfg.path || "/apps/{app_id}/api-keys", appId);
    try {
      const res = await fetch(listUrl, { method: "GET", headers, credentials: "same-origin" });
      if (res.status === 200) {
        const body = await safeJson(res);
        const items = body && (body.data || body.items || (Array.isArray(body) ? body : null));
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it && typeof it.token === "string" && it.token) {
              await persistAppKey(appId, it.token);
              return it.token;
            }
          }
        }
      }
    } catch (e) {
      /* 忽略,继续走 create */
    }
  }

  // 3) POST create(响应含 token,一次性可见 → 当下持久化)
  const createUrl = consoleUrl(adapter, (createCfg && createCfg.path) || "/apps/{app_id}/api-keys", appId);
  let res;
  try {
    res = await fetch(createUrl, { method: "POST", headers, credentials: "same-origin", body: "{}" });
  } catch (e) {
    throw new Error("创建 API key 失败:" + ((e && e.message) || e));
  }
  const body = await safeJson(res);
  const token = body && body.token;
  if (res.status >= 200 && res.status < 300 && token) {
    await persistAppKey(appId, token);
    return token;
  }
  throw new Error(
    "创建 API key 失败(HTTP " + res.status + "):" + ((body && (body.error || body.message)) || "")
  );
}

// 发布草稿(console,cookie+CSRF)→ 使 Service API 能跑到最新已发布版本
async function publishDraft(appId, adapter) {
  const ep = adapter && adapter.console && adapter.console.endpoints;
  const pubCfg = ep && ep.draftPublish;
  const path = (pubCfg && pubCfg.path) || "/apps/{app_id}/workflows/publish";
  // 发布动作固定 POST(adapter.draftPublish.method 已为 POST;GET 是「读已发布版本」,不是发布)
  const method = "POST";
  const url = consoleUrl(adapter, path, appId);
  const headers = buildHeaders(adapter);
  let res;
  try {
    res = await fetch(url, { method, headers, credentials: "same-origin", body: "{}" });
  } catch (e) {
    throw new Error("发布草稿失败:" + ((e && e.message) || e));
  }
  // 发布失败不应静默(否则 run 会跑旧版);抛错让上层呈现
  if (res.status < 200 || res.status >= 300) {
    const body = await safeJson(res);
    throw new Error("发布草稿失败(HTTP " + res.status + "):" + ((body && (body.error || body.message)) || ""));
  }
  return true;
}

// 运行 workflow:①发布草稿 ②取/建 app key ③POST /v1/workflows/run(blocking)
// 返回 { ok, status, outputs, error, workflowRunId, taskId, elapsedTime, totalTokens, totalSteps }
async function runWorkflow(appId, inputs, adapter) {
  if (!appId) return { ok: false, error: "缺少 appId" };
  if (!adapter || !adapter.console || !adapter.serviceApi) {
    return { ok: false, error: "adapter 缺失 console/serviceApi 配置" };
  }

  // inputs 归一化:接受对象或 JSON 字符串;非法一律按空对象(不强制填参,MVP)
  let inputsObj = inputs;
  if (typeof inputs === "string") {
    try {
      inputsObj = inputs.trim() ? JSON.parse(inputs) : {};
    } catch (e) {
      return { ok: false, error: "输入 JSON 解析失败:" + ((e && e.message) || e) };
    }
  }
  if (inputsObj == null || typeof inputsObj !== "object" || Array.isArray(inputsObj)) {
    inputsObj = {};
  }

  // ①发布
  try {
    await publishDraft(appId, adapter);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // ②取/建 app key
  let appKey;
  try {
    appKey = await obtainAppKey(appId, adapter);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // ③run
  const sa = adapter.serviceApi;
  const runCfg = sa.endpoints && sa.endpoints.runWorkflow;
  const runPath = (runCfg && runCfg.path) || "/v1/workflows/run";
  const baseUrl = sa.baseUrl || "http://localhost";
  const authScheme = (sa.auth && sa.auth.scheme) || "Bearer";

  let res;
  try {
    res = await fetch(baseUrl + runPath, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authScheme + " " + appKey,
      },
      body: JSON.stringify({ inputs: inputsObj, user: "indify", response_mode: "blocking" }),
    });
  } catch (e) {
    return { ok: false, error: "运行 workflow 失败:" + ((e && e.message) || e) };
  }

  const body = await safeJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (body && (body.error || body.message)) || "运行失败(HTTP " + res.status + ")",
    };
  }

  const data = body && body.data;
  return {
    ok: isRunSuccess(data),
    status: data && data.status,
    outputs: data ? data.outputs : undefined,
    error: data ? data.error : undefined,
    workflowRunId: body && body.workflow_run_id,
    taskId: body && body.task_id,
    elapsedTime: data && data.elapsed_time,
    totalTokens: data && data.total_tokens,
    totalSteps: data && data.total_steps,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "indify:ping") {
    sendResponse({ type: "indify:pong", context: detectContext() });
    return true;
  }

  if (message.type === "indify:getContext") {
    sendResponse({ type: "indify:context", context: detectContext() });
    return true;
  }

  if (message.type === "indify:injectCreate") {
    injectCreate(message.yamlText, message.adapter)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message.type === "indify:getDraft") {
    getDraft(message.appId, message.adapter)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message.type === "indify:injectModify") {
    injectModify(message.appId, message.graphText, message.adapter)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message.type === "indify:getDslVersion") {
    // 版本探测(M4):同源读 /app-dsl-version,免登录
    getDslVersion()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message.type === "indify:runWorkflow") {
    runWorkflow(message.appId, message.inputs, message.adapter)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // indify:status / indify:task 等广播:忽略,不响应
});

/** 同源探测 Dify 的 DSL 版本(免登录端点)。 */
async function getDslVersion() {
  try {
    const res = await fetch("/console/api/app-dsl-version", { credentials: "same-origin" });
    const body = await res.json();
    if (res.ok && body && typeof body.app_dsl_version === "string") {
      return { ok: true, appDslVersion: body.app_dsl_version };
    }
    return { ok: false, error: "app-dsl-version 响应异常" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

reportContext();
