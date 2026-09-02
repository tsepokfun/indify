# ADL · S1 技能卡 manifest 標準與反推生成器

> 狀態:**提案(待導演拍板)**
> 範圍:Indify v3 技能運行時層的 S1 —— 只做「技能卡 manifest 標準 + 反推生成器」,不碰運行、不碰註冊中心。
> 對齊:`docs/v3-skill-runtime-藍圖.md` L1、`DESIGN.md` §5.4/§6、`docs/s0-service-api-findings.md`(執行側,了解 app_id/workflow 概念即可)。

## 1. 背景

把每個 Dify workflow 當成 AI 可調用的 skill,第一步是讓 skill「自述」:一張技能卡(manifest)告訴 Agent 它是誰、何時用、吃什麼、吐什麼、有沒有副作用、怎麼算成功。S1 交付兩件:

1. `registry/skillcard.schema.json` —— manifest 的 JSON Schema 標準。
2. `registry/generate-skillcard.mjs` —— 從一個 Dify DSL YAML 導出檔反推技能卡(JSON + 可讀 .md),入出參 schema 一律反推、不手寫(藍圖 §6 默認)。

## 2. 決策與理由

### D1 — manifest 字段(對齊藍圖 L1,故意略去 `cost`)

藍圖 L1 列了 `name / description / when-to-use / input schema / output schema / side-effects / cost / how-to-verify`。S1 的字段**刻意略去 `cost`**,理由:`cost`(延時/錢)是**運行時才知道**的數據,S1 靜態反推只能瞎猜,徒增誤導。留到 S2 執行適配器跑過之後回填。字段命名統一 snake_case(`when_to_use`、`app_id`、`success_field`),與 Dify 既有 JSON 慣例一致。

| 字段 | 型別 | 必填 | 反推來源 |
|---|---|---|---|
| `id` | slug | 是 | app.name → slug;中文名無 ASCII 時退檔名 slug,再退 `skill-<sha1 前 8>` |
| `name` | string | 是 | app.name,缺則檔名兜底 |
| `description` | string | 是 | app.description,缺則「Dify 工作流 <name>」 |
| `when_to_use` | string | 是 | 由 name/description/入出參組自然語言草稿,Agent 可再精修 |
| `app_id` / `workflow_id` | string\|null | 否 | 僅來自可選 app 元數據 JSON(DSL 導出檔本身不含 id) |
| `input_schema` | object | 是 | start 節點 variables;缺則退 environment_variables |
| `output_schema` | object | 是 | end 節點 outputs 的 value_selector 目標變數 |
| `side_effects` | {tier, notes} | 是 | 掃全部節點類型聚合最高分級 |
| `verify` | {how, success_field?, success_values?} | 是 | 預設 how;success_field 僅對布林式成功欄做輕量啟發式 |
| `source` | {kind, dslPath?, version?} | 是 | kind 恆 `dify-workflow`;version 取 DSL `version` |

### D2 — 反推規則(名稱/描述/入出參)

- **name/description**:取 `app.name` / `app.description`;官方 echo 樣例兩者都有,缺則檔名兜底(任務要求)。description 為空字串時不崩,仍產卡。
- **input_schema**:`start.data.variables[]` → `{type, description, required}`。`description` 取變數 `description` 欄,退 `label`;`required` 取 `required` 布林。類型推斷對照表(缺省 `string`):

  | Dify start type | 技能卡 type |
  |---|---|
  | text-input / paragraph / select / external_data_tool | string |
  | number | number |
  | checkbox | boolean |
  | json_object | object |
  | file | file |
  | file-list | array |

  若 start 無 variables(或根本沒 start),退 `workflow.environment_variables[]`,轉成 `{type, description, required:false}`(環境變數非使用者輸入,故必填 false)。兩者皆空 → 空 schema `{}`,不崩。

- **output_schema**:`end.data.outputs[]` → `{type, description}`。`type` 由 `value_type` 推斷(integer→number、array[xxx]→array、缺省 string);`description` 僅當來源節點是 start 時取用其 label/description,否則空字串(DSL 本身不帶輸出描述)。無 end 或 outputs 空 → 空 schema。

### D3 — 副作用判定(保守策略)

分級五階、**聚合取全圖最高**:`none < read < write < external_send < irreversible`。判定依據 = node-catalog.md 的 28 類節點全集:

| 分級 | 節點 | 理由 |
|---|---|---|
| none | start/end/answer/llm/if-else/code/question-classifier/variable-aggregator/template-transform/parameter-extractor/assigner/variable-assigner/list-operator/iteration/loop 家族/human-input/trigger 家族 | 純計算/控制流,無對外寫入 |
| read | knowledge-retrieval / datasource / document-extractor | 讀內部知識庫/外部資料源/文件,不改動外部 |
| external_send | http-request / tool / agent | 對外呼叫 |

三條**保守底線**(任務明示):
1. `http-request` 一律 `external_send`(不分 method,因為靜態無法保證 GET 無副作用),note 記 method。
2. `tool` 做名稱啟發式:含 mail/email/send/sms/notify/webhook/publish → `external_send`;含 write/insert/update/delete/upsert/create/save/db/sql → `write`;其餘「對外/寫庫未知」仍保守 `external_send`。
3. **未知節點類型 → 保守 `write` 並寫 note**(未來 Dify 升版新增節點時,寧可高估、不低估)。

### D4 — verify 預設

- `how` 恆為「workflow run 状态为 succeeded 且 outputs 非空」(對齊 s0 的 blocking 響應 `data.status === "succeeded"` 且 `data.outputs` 非空)。
- `success_field` 僅當 end 輸出變數名命中 `success/ok/is_success/succeeded/passed/status` 時才填;命中布林式名稱再補 `success_values`(true/1/success/ok/succeeded/passed)。這只是啟發式,留給 S2 執行適配器做真正判定。

### D5 — 依賴與目錄

- 腳本只依賴已在的 `yaml@2.x`(v2.9.0)。因 `registry/` 目前無自己的 node_modules,腳本以相對路徑 `../skills/dify-workflow-dsl/node_modules/yaml/dist/index.js` 直接引用該已裝副本(已實測 `YAML.parse` 可用),避免二次安裝。**注意**:這是 S1 的過渡做法;L2 若把 registry 獨立成包,應在 `registry/package.json` 正規聲明 yaml 依賴。
- 只新增 `registry/` 下檔案與本文檔;未改動 bridge/、extension/、skills/、tools/ 任何既有檔。

## 3. 留給導演的開放問題

1. **`cost` 字段**:S1 略去,是否如預期由 S2 運行後回填?欄位形狀(延時 ms / token / 金額)待定。
2. **分級順序**:`write` 與 `external_send` 誰更「重」?目前按 `write < external_send`(發送可能不可逆,如郵件已寄出)。若認為「寫庫更難回滾」需調換。
3. **knowledge-retrieval 用 `read` 而非任務字面的 `none`**:任務 anchor 寫「knowledge → none」,但 `read` 對 Agent 是更準確的訊號(讀了內部知識庫、對外部世界無寫入)。已採 `read`,若導演要嚴格照字面改 `none`,一行即改。
4. **`code` / `agent` 節點**:`code` 標 `none`(沙箱預設無網路),`agent` 標 `external_send`(可調工具)。兩者都是「可能越界」的灰區,是否需要更細的靜態掃描(如 code 內 grep 網路 API)?
5. **output description 為空**:DSL 不帶輸出描述,目前除 start 來源外皆空字串。是否 S2 從生產節點的 data 反推描述來豐富?
6. **id 中文化**:中文 app 名 slug 化為空 → 退 `skill-<hash>`(不可讀)。是否要維護一份人工可讀的 id 別名表,或引入拼音/翻譯?
7. **schema 校驗時機**:S1 未引入 JSON Schema 校驗器(不加依賴),產出「按構造即符合」;是否在 L2 註冊中心引入校驗(如 ajv)作為入庫閘口?
8. **app 元數據 JSON 形狀**:目前採扁平鍵 `{app_id, workflow_id, name, description}`(自定)。是否與 Dify 實際「應用列表」API 的回傳形狀對齊,避免二度轉換?
9. **when_to_use 草稿**:目前是模板組字,是否要讓 Builder Agent 在生成工作流時順手寫一段更好的指引(而非反推)?
