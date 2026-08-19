# Indify Chrome 扩展(骨架版 M1-C)

> Indify = Chrome 扩展聊天框 + 本地伴生服务(Indify Bridge)+ DSL 适配层,让用户用自然语言生成/修改 Dify 1.16.1 工作流(Dify 控制台在 `http://localhost`)。
>
> 本目录是 **M1-C 骨架**:Side Panel 聊天框空壳 + Service Worker(持有 Bridge 的 ws 连接)+ Content Script(检测当前 Dify 应用上下文)。**不含** React、构建链与真实业务逻辑;M2/M3 在此骨架上填充。

## 1. 目录结构

```
extension/
├─ manifest.json       # MV3:name "Indify",version "0.1.0";权限最小集
├─ README.md           # 本文档
├─ sidepanel.html      # 聊天框空壳:顶部状态条 + 输入框(禁用态占位)+ 消息占位区
├─ sidepanel.js        # 从 SW 拉状态 / 订阅 onMessage 渲染状态;纯 JS 无外部依赖
├─ service-worker.js   # 持有 ws://127.0.0.1:39181/v1/events 连接:退避重连 + 心跳 + 状态广播
└─ content-script.js   # 注入 http://localhost/*:识别当前 app 上下文并上报/响应 SW
```

## 2. 安装(unpacked 加载)

1. 打开 Chrome,地址栏进入 `chrome://extensions`。
2. 右上角打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**,选择本目录 `D:\difyIndify\extension`。
4. 在浏览器打开 Dify 控制台 `http://localhost`(content script 会在此域注入)。
5. 点工具栏上的 **Indify 扩展图标**,右侧即出现侧边栏(扩展已在启动时调用 `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`)。

> 若点图标无反应:可在图标上右键 →「打开侧边栏」;或确认 Chrome ≥ 116(manifest 已设 `minimum_chrome_version: 116`,sidePanel 需要)。

## 3. 骨架功能说明

- **Side Panel(聊天框空壳)**
  - 顶部状态条:圆点 + 文案显示 Bridge 连接状态(已连接 / 未连接);下方一行显示当前 Dify 页上下文(appId / 应用名 / 模式 / 页面类型)。
  - 输入框:当前为 **禁用态占位**,M2 起启用为自然语言输入。
  - 消息区:占位提示,说明 M2 起将显示对话消息 / 任务进度 / 结构预览卡片与「确认/修正」按钮。
- **Service Worker**
  - 持有 `ws://127.0.0.1:39181/v1/events` 连接;断线按 `1s/2s/4s/…` 指数退避重连,封顶 `30s`。
  - 每 20s 发送心跳帧(`{"type":"ping","ts":...}`,M2 前为占位格式),并做僵死检测(60s 无帧则强制重连)。
  - 状态变化即广播 `indify:status` 并写入 `chrome.storage.session`(面板重开可恢复)。
- **Content Script**
  - 识别当前 app:`/app/{uuid}/workflow` → `page:"workflow"`,`mode:"workflow"`;`/apps` → `page:"apps"`;其余 `page:"other"`;从 URL 提取 `appId`,从 `document.title` 提取 `appName`。
  - 页面加载即上报;响应 SW 的 `ping` 与 `getContext` 请求(重新检测当前 URL,天然兼容 Dify 的 SPA 内跳转)。

## 4. 与 Indify Bridge 的连接说明

- Bridge 默认地址:`ws://127.0.0.1:39181/v1/events`(见 DESIGN §5.2)。
- **认证(Bridge token)**:Bridge 除 `/v1/health` 外的接口要求 token(`.indifyrc.yaml` 的 `token` 值)。
  侧边栏在「Bridge 未连接」时会显示 token 粘贴框:粘贴后保存 → SW 自动重连。
  token 只存于本机 `chrome.storage.local`(`bridgeToken` 键),不会离开浏览器。
- **WebSocket 到 `ws://127.0.0.1` 在 MV3 无需额外权限**;本扩展的 `host_permissions` 覆盖 `http://127.0.0.1/*` 以兼容 Bridge 的 HTTP 接口(`/v1/health`、`/v1/tasks` 等,M2 起使用)。
- **Bridge 未启动时**:SW 的 WebSocket 连接失败/关闭 → `connected:false`,侧边栏状态条显示「Bridge 未连接」,并按退避策略持续重连;Bridge 一旦启动即自动恢复为「Bridge 已连接」。
- 心跳帧与 Bridge 的**帧格式为占位**:M1 阶段 `ws.onmessage` 仅记录帧;M2 起按 §5.2 解析 `task.progress / task.result / task.error / hitl.request` 帧。

## 5. 消息协议(骨架版)

命名与 M2 计划兼容。核心字段见下;`context` 结构统一为
`{ appId?, appName?, mode?, page: "workflow"|"apps"|"other", url }`。

| 方向 | 消息 | 说明 |
|---|---|---|
| content script → SW | `{ type:"indify:context", context:{…} }` | 上报当前应用上下文(加载时 + 响应请求时) |
| SW → panel(广播) | `{ type:"indify:status", bridge:{ connected, url }, context:{…} }` | 状态广播(连接变化 / 上下文变化 / 面板请求时) |
| panel → SW | `{ type:"indify:getStatus" }` | 面板请求当前状态,SW 回广播 `indify:status` |
| SW → content script | `{ type:"indify:getContext" }` | 显式请求当前上下文 |
| content script → SW(响应) | `{ type:"indify:context", context:{…} }` | 对 `getContext` 的响应(sendResponse) |
| SW → content script | `{ type:"indify:ping" }` | 存活探测 + 上下文刷新(周期 30s) |
| content script → SW(响应) | `{ type:"indify:pong", context:{…} }` | 对 `ping` 的响应(sendResponse) |

状态存储:`chrome.storage.session`(`bridge` 与 `context` 两个键),面板重开可恢复。

## 6. 占位符与 M2/M3 接缝(摘要)

| 位置 | 当前骨架 | M2/M3 替换为 |
|---|---|---|
| `sidepanel.html` 输入框 | 禁用态占位 | 自然语言输入 + 发送 |
| `sidepanel.html` 消息区 | 静态占位文案 | 对话消息 / 任务进度 / IR 结构预览卡片 + 确认/修正按钮 |
| `service-worker.js` `onmessage` | 仅 `console.debug` 记录 | 解析 Bridge 任务帧并推送面板 |
| `service-worker.js` 心跳帧 | `{"type":"ping"}` 占位 | 与 Bridge 对齐的保活/订阅帧 |
| `content-script.js` 上下文检测 | URL + title 启发式 | 读取草稿 graph(§8.2)、版本探测、注入操作 |
| `service-worker.js` 任务编排 | 无 | 提交任务、adapter 缓存、HITL 状态机 |
