// Indify content script — M2(新建链路 U1)
// 注入 http://localhost/*(Dify 控制台):
//   1. 识别当前 app 上下文(appId / appName / mode / page / url)
//   2. 上报给 service worker({type:"indify:context"})
//   3. 响应 SW 的 ping / getContext
//   4. 执行 DSL 导入(indify:injectCreate,route B,§8.1)
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

// ---------- DSL 导入(route B) ----------
function readCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
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

// 执行控制台导入:POST /apps/imports(202 时 confirm)。返回 {ok, appId?, error?}
async function injectCreate(yamlText, adapter) {
  if (!yamlText) return { ok: false, error: "yamlText 为空" };
  if (!adapter || !adapter.console) return { ok: false, error: "adapter 缺失 console 配置" };

  const c = adapter.console;
  const baseUrl = c.baseUrl || "http://localhost";
  const apiPrefix = c.apiPrefix || "/console/api";
  const importCfg = c.endpoints && c.endpoints.importDsl;
  const confirmCfg = c.endpoints && c.endpoints.importConfirm;
  const csrfHeader = (c.csrf && c.csrf.headerName) || "X-CSRF-Token";

  if (!importCfg) return { ok: false, error: "adapter 缺少 importDsl 端点" };

  const importUrl = baseUrl + apiPrefix + (importCfg.path || "/apps/imports");
  const csrfToken = readCsrfToken();
  const headers = { "Content-Type": "application/json" };
  if (csrfToken) headers[csrfHeader] = csrfToken;

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

    const confirmPath = (
      (confirmCfg && confirmCfg.path) || "/apps/imports/{import_id}/confirm"
    ).replace("{import_id}", importId);
    const confirmUrl = baseUrl + apiPrefix + confirmPath;

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

  // indify:status / indify:task 等广播:忽略,不响应
});

reportContext();
