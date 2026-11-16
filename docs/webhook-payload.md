# Notify Webhook 输出数据格式清单

> 对应 `spec.md` **v1.25**。本文只回答一个问题：**Notify 发出的出站 POST 请求长什么样**。
> 权威实现：`src/dispatch/message.ts`（通用结构）、`src/dispatch/adapters.ts`（平台适配）、
> `src/dispatch/webhook.ts`（签名与重试）、`src/dispatch/index.ts`（渠道分发）。
> 本文所有样例都由本地假数据实跑生成，域名一律用 `.invalid` 占位，**不含任何真实凭据或 URL**。
>
> 相关文档：[配置参考](configuration.md)（怎么配）、[部署指南](deployment.md)（怎么跑）、
> [Cloud API 调用清单](cloud-api.md)（入站只读接口，与本文的出站 POST 是两回事）、
> [页面操作手册](admin-guide.md)。

---

## 1. 一句话结论

按 `NOTIFY_WEBHOOK_ADAPTERS` 与 `WEBHOOK_URLS` 一一对应，共 **4 种出站形态**：

| 适配器 | Body | 签名位置 | 触发前提 |
|---|---|---|---|
| `generic`（默认） | 完整结构化 `NotifyMessage` JSON | 请求头 `X-Notify-Signature` | `WEBHOOK_ENABLED=true` |
| `dingtalk` | 钉钉 markdown 机器人格式 | URL 查询参数 `timestamp` + `sign` | M3 适配器显式声明 |
| `wecom` | 企业微信 text 机器人格式 | **无签名**（密钥在 Webhook URL 里） | M3 适配器显式声明 |
| `feishu` | 飞书 text 机器人格式 | JSON body 的 `timestamp` + `sign` | M3 适配器显式声明 |

所有形态都是 **`POST` + `Content-Type: application/json`**，body 是紧凑 JSON（`JSON.stringify`，无缩进、无尾随空格），UTF-8 编码。`generic` 与三个平台适配器的 body **完全不同**：前者给机器读的结构化数据，后三者把同一份数据渲染成一段给人看的中文纯文本。

---

## 2. 传输层（四种形态共同）

| 项 | 值 / 行为 |
|---|---|
| 方法 | `POST`（`fetch` 的 `method: 'POST'`） |
| 请求头基线 | `Content-Type: application/json`；仅 `generic` 额外带两个 `X-Notify-*` 头 |
| 单次超时 | 10 秒（`AbortSignal.timeout(10_000)`） |
| 成功判定 | **2xx 且业务码为 0**（v1.15 起）；3xx / 4xx / 5xx 失败，2xx 里 `errcode!=0` 也算失败，详见 §10 |
| 重试 | 最多 `WEBHOOK_MAX_ATTEMPTS` 次（默认 3），指数退避 `200ms → 400ms → 800ms …`；**业务码失败不即时重试** |
| 重试时的 body | **同一份字符串原样重发**，不会重新序列化，所以签名也保持不变 |
| 渠道级独立 | 每个 URL 是独立渠道 `webhook:0` / `webhook:1`…，一个失败不影响其它，也不影响邮件 |
| 去重 | 状态库按「触发点去重键 + 渠道名」记录；成功只发一次，重启不重复投递 |
| 日志与状态库 | 只记渠道短名，**不记 URL**（URL 常带密钥）；失败原因里的 URL 统一替换成 `[url]` |

> ⚠️ **接收端必须自己实现幂等**。同一触发点正常只发一次，但失败重试会重发相同 body；
> 若渠道整轮失败后下一轮重投，会重新渲染消息，`sentAt` 变化、body 也随之变化。
> 建议用 `event` + `task.id` + `trigger.at` 这类业务键做幂等，而不是 `sentAt`。

---

## 3. `generic` 通道：完整字段表

`NotifyMessage` 定义在 `src/dispatch/message.ts:23`。**顶层字段全部是条件性的**——没有的键直接不出现，不会是 `null` 或空对象。

### 3.1 顶层

| 路径 | 类型 | 必填 | 出现条件 | 说明 |
|---|---|---|---|---|
| `event` | `string` | ✅ | 总是 | 事件类型，见 §4 |
| `sentAt` | `string` | ✅ | 总是 | 渲染时刻的 UTC ISO 8601，如 `2026-11-15T13:00:00.000Z` |
| `task` | `object` | — | 任务级提醒（6 种，**不含** `task.project_review`） | 见 §3.2 |
| `project` | `object` | — | 仅 `task.project_review`（BASE-07 项目回顾） | 只含 `id` 与 `title`，见 §3.6 |
| `trigger` | `object` | — | 与 `task` 或 `project` 同时出现 | 见 §3.3 |
| `digest` | `object` | — | 三类摘要、`date_only` | 见 §3.4 |
| `backlog` | `object` | — | `backlog` 事件 | 见 §3.5 |
| `note` | `string` | — | `system` 事件 | 告警正文，失败原因已脱敏 |

> **v1.22 起不再有 `links`**：Mindwtr Cloud 没有可直接打开的 Web 任务页，
> 旧的 `links.app`（`<MINDWTR_BASE_URL>/#/task/<id>`）在接收方点开是 404，已从所有渠道移除。
> 若你的接收端之前依赖它，请改成直接搜任务标题，或自己从 `task.id` 拼你认为可用的地址。

### 3.2 `task`（单任务提醒，EXT-02【增强】结构化）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | 任务 id |
| `title` | `string` | ✅ | 缺失时回落 `(无标题)` |
| `status` | `string` | ✅ | 如 `inbox` / `next` / `waiting` / `someday` |
| `dueDate` | `string` | — | 原样透传 Cloud 字段（ISO 8601），未设置则不出现 |
| `startTime` | `string` | — | 同上 |
| `reviewAt` | `string` | — | 同上 |
| `projectId` | `string` | — | 同上 |
| `projectName` | `string` | — | 由 `/v1/projects` 缓存映射，映射不到则不出现 |
| `description` | `string` | — | **去 Markdown 后的纯文本**（`stripMarkdown`），只在单任务提醒里出现 |

> `description` 会被 `stripMarkdown` 处理：代码块、图片、链接语法、`*_~`#>-` 等标记替换成空格，连续空白合并。
> 例：`**重点**：完成联调` → `重点 ：完成联调`。

### 3.3 `trigger`

| 字段 | 类型 | 必填 | 出现条件 | 说明 |
|---|---|---|---|---|
| `type` | `string` | ✅ | 总是 | 触发种类，如 `due` / `due-advance` / `due-repeat` / `start` / `review` |
| `at` | `string` | ✅ | 总是 | 计划触发时刻的 UTC ISO 8601 |
| `leadMinutes` | `number` | — | `*-advance` | 提前量，分钟 |
| `repeatIndex` | `number` | — | `due-repeat` | 第几次重复提醒（从 1 起），与去重键 `${dueDate}#${index+1}` 对应 |

### 3.4 `digest` 与 `TaskSummary`

`digest` 固定含 **4 个数组**（即使是空数组也会出现）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `dueToday` | `TaskSummary[]` | 今日到期 |
| `overdue` | `TaskSummary[]` | 已逾期 |
| `startingToday` | `TaskSummary[]` | 今日开始 |
| `focused` | `TaskSummary[]` | 专注任务 |

`TaskSummary` 是刻意收窄的白名单（`EXT-03`【官方无】数据最小化）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | 任务 id |
| `title` | `string` | ✅ | 缺失时 `(无标题)` |
| `status` | `string` | ✅ | 任务状态 |
| `dueDate` | `string` | — | 有才出现 |
| `startTime` | `string` | — | 有才出现 |

> 摘要 / backlog 的每一项都**没有 `description`**，也没有 `projectName` / `reviewAt`。

`EXT-16` 的 `date_only` 事件复用 `digest` 结构：仅 `dueToday` 有数据，其余三个数组恒为空。

### 3.5 `backlog`

| 字段 | 类型 | 说明 |
|---|---|---|
| `count` | `number` | 逾期任务总数 |
| `tasks` | `TaskSummary[]` | 逾期任务清单（字段白名单同上） |

### 3.6 `project`（项目回顾，BASE-07）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | 项目 id |
| `title` | `string` | — | 项目标题（项目没有标题时该键不出现） |

> 只外发这两个字段：项目状态、成员、标签等一律不带（EXT-03 数据最小化）。
> 项目回顾**没有 `task` 块**，用 `project` + `trigger` 表达；`trigger.type` 固定为 `project-review`。

---

## 4. `event` 全集（14 种）

| `event` | 什么时候产生 | 顶层特有字段 | 来源 |
|---|---|---|---|
| `task.start` | 任务开始时刻 | `task` + `trigger` | BASE 规则 |
| `task.start_advance` | 开始前的提前提醒 | `task` + `trigger(leadMinutes)` | BASE 规则 |
| `task.due` | 任务截止时刻 | `task` + `trigger` | BASE 规则 |
| `task.due_advance` | 截止前的提前提醒 | `task` + `trigger(leadMinutes)` | BASE 规则 |
| `task.due_repeat` | 截止后重复催办 | `task` + `trigger(repeatIndex)` | BASE 规则 |
| `task.review` | 任务回顾时刻 | `task` + `trigger` | BASE 规则 |
| `task.project_review` | 项目回顾时刻 | `project` + `trigger` | BASE-07【一致】 |
| `digest_morning` | 每日 09:00（默认开） | `digest` | BASE-08【一致】 |
| `digest_evening` | 每日 20:00（默认开） | `digest` | BASE-09【一致】 |
| `digest_weekly` | 每周日 18:00（默认开） | `digest` | BASE-10【一致】 |
| `date_only` | 仅日期任务当日 09:00 | `digest` | EXT-16【官方无】**默认关闭** |
| `backlog` | 启动积压逾期汇总 | `backlog` | EXT-17【官方无】**默认关闭** |
| `system` | Cloud 连续失败 / 恢复告警 | `note` | EXT-11【官方无】 |
| `test` | `--test-webhook` 渠道自检 | 无（最小消息） | EXT-13【官方无】 |

> 三类摘要共用**完全相同**的 `digest` 结构，只有 `event` 不同；
> `strict` 模式下 `date_only` / `backlog` 不会产生，事件集合只剩前 7 + 3 + `system` / `test`。
> 平台适配器 `eventLabel` 覆盖了全部 14 种事件（v1.24 补齐 `task.project_review` → 「项目回顾」）。

---

## 5. `generic` 通道样例

### 5.1 单任务提醒 `task.due`（最完整的一种）

```json
{
  "event": "task.due",
  "sentAt": "2026-11-15T13:00:00.000Z",
  "task": {
    "id": "task-abc123",
    "title": "示例任务",
    "status": "next",
    "dueDate": "2026-11-15T15:00:00.000Z",
    "startTime": "2026-11-15T13:00:00.000Z",
    "projectId": "proj-1",
    "projectName": "示例项目",
    "description": "重点 ：完成联调"
  },
  "trigger": { "type": "due", "at": "2026-11-15T15:00:00.000Z" }
}
```

`task.due_advance` / `task.due_repeat` 只在 `trigger` 里多一个键：

```json
{ "type": "due-advance", "at": "2026-11-15T14:30:00.000Z", "leadMinutes": 30 }
{ "type": "due-repeat", "at": "2026-11-15T15:30:00.000Z", "repeatIndex": 1 }
```

### 5.2 摘要 `digest_morning`

```json
{
  "event": "digest_morning",
  "sentAt": "2026-11-15T13:00:00.000Z",
  "digest": {
    "dueToday": [
      { "id": "task-1", "title": "今天到期", "status": "next", "dueDate": "2026-11-15T15:00:00.000Z" }
    ],
    "overdue": [
      { "id": "task-2", "title": "已逾期", "status": "next", "dueDate": "2026-11-14T10:00:00.000Z" }
    ],
    "startingToday": [],
    "focused": [{ "id": "task-3", "title": "专注任务", "status": "next" }]
  }
}
```

### 5.3 积压 `backlog`

```json
{
  "event": "backlog",
  "sentAt": "2026-11-15T13:00:00.000Z",
  "backlog": {
    "count": 1,
    "tasks": [
      { "id": "task-2", "title": "已逾期", "status": "next", "dueDate": "2026-11-14T10:00:00.000Z" }
    ]
  }
}
```

### 5.4 系统告警 `system` 与自检 `test`

```json
{ "event": "system", "note": "已连续 3 轮拉取失败，最后错误：[url]",
  "sentAt": "2026-11-15T13:00:00.000Z" }

{ "event": "test",
  "sentAt": "2026-11-15T13:00:00.000Z" }
```

### 5.5 项目回顾 `task.project_review`

```json
{
  "event": "task.project_review",
  "sentAt": "2026-11-16T15:00:00.000Z",
  "project": { "id": "proj-1", "title": "示例项目" },
  "trigger": { "type": "project-review", "at": "2026-11-16T15:00:00.000Z" }
}
```

> 项目已归档 / 已删除、或 `reviewAt` 只写日期（`2026-11-16`）时，不会产生这条事件。

---

## 6. `generic` 请求头与验签

| 请求头 | 值 | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 固定 |
| `X-Notify-Timestamp` | Unix **秒**，如 `1794747600` | 防重放 |
| `X-Notify-Signature` | `sha256=<64 位 hex>` | HMAC-SHA256 |

```
签名串   = `${timestamp}.${rawBody}`
签名值   = HMAC_SHA256(key = WEBHOOK_SECRET, data = 签名串).hex
完整头   = 'sha256=' + 签名值
```

**`rawBody` 必须是发送时的原始请求体字节**；接收方不能把 JSON 解析后重新序列化再验签——空格、字段顺序变化都会验不过。时间戳偏差超过 **300 秒**直接拒绝。

> 即使 `WEBHOOK_SECRET` 为空，通用通道**仍会带这两个头**（只是用空密钥算 HMAC）；
> 生产环境务必配置密钥。接收端校验示例见 [配置参考 §5](configuration.md)。
> 钉钉 / 企业微信 / 飞书适配器**不走这套通用头**，只有 `Content-Type`。

---

## 7. 三个平台适配器

平台 body 由 `renderPlatformText()` 把同一份 `NotifyMessage` 渲染成中文纯文本。文本规则：

- 首行固定 `【事件中文标签】`；**不输出任何链接**（v1.22 起，Cloud 没有可打开的 Web 任务页）。
- 抬头明确来源与时间类别：`【任务提醒 · 截止时间】` / `【任务提醒 · 开始时间】` /
  `【任务提醒 · 回顾时间】` / `【项目提醒 · 回顾时间】` / `【其他提醒 · …】`。
- 任务级：依次输出任务标题、**触发本次的那种时间**（只打一种，避免同时有截止时间与开始时间时分不清）、
  项目名、描述（**有才输出**）。
- 摘要：只输出「今日到期 N 条 / 逾期 N 条」，然后列 `dueToday + overdue` 的**前 5 条**标题；
  `startingToday` / `focused` **不会**出现在平台文本里（结构化 `generic` 通道才有）。
- backlog：输出总数，再列前 5 条标题。
- `system`：输出 `note` 正文。
- 项目回顾：输出项目名与回顾时间（`项目：…` / `回顾时间：…`），没有任务块。
- **时间按 `NOTIFY_TIME_FORMAT` 渲染**（默认 `yyyy-MM-dd HH:mm:ss`，业务时区，见
  [配置参考 §4.2.2](configuration.md)）。上面样例里的 `2026-11-15 23:00:00` 就是 UTC 15:00 的北京时间。
  这是**平台文本专属**：`generic` 通道的 JSON 始终是 ISO 8601，不受该配置影响。

### 7.1 钉钉 `dingtalk`

签名在 **URL 查询参数**：`timestamp` 是**毫秒**，`sign` 是 base64；
算法 `HMAC_SHA256(key = secret, data = "${timestampMs}\n${secret}")`，再 base64。

```text
POST https://hooks.example.invalid/robot?access_token=PLACEHOLDER&timestamp=1794747600000&sign=<base64-sign>
Content-Type: application/json
```
```json
{
  "msgtype": "markdown",
  "markdown": {
    "title": "Notify 提醒",
    "text": "【任务提醒 · 截止时间】\n任务：示例任务\n截止时间：2026-11-15 23:00:00\n项目：示例项目\n描述：重点 ：完成联调"
  }
}
```

### 7.2 企业微信 `wecom`

**没有签名**（密钥本来就在 Webhook URL 的 `key` 参数里），body 是最简的 text 格式。

```json
{
  "msgtype": "text",
  "text": {
    "content": "【任务提醒 · 截止时间】\n任务：示例任务\n截止时间：2026-11-15 23:00:00\n项目：示例项目\n描述：重点 ：完成联调"
  }
}
```

### 7.3 飞书 `feishu`

签名在 **JSON body**：`timestamp` 是**秒**，`sign` 是 base64；
算法 `HMAC_SHA256(key = "${timestampSec}\n${secret}", data = "")`，再 base64。

```json
{
  "msg_type": "text",
  "content": { "text": "【任务提醒 · 截止时间】\n任务：示例任务\n…" },
  "timestamp": "1794747600",
  "sign": "<base64-sign>"
}
```

> ⚠️ **钉钉与飞书最容易写反**：钉钉把「时间戳+换行+密钥」当作**被签名的数据**、密钥是 secret；
> 飞书把同一串当作 **HMAC 的密钥**、被签名数据是空串。且钉钉时间戳用毫秒、飞书用秒。
> 两者的 `sign` 都只在 `NOTIFY_WEBHOOK_SECRETS` 对应位非空时才生成。

---

## 8. 数据最小化与隐私边界

| 约束 | 实际情况 |
|---|---|
| 绝不外发 | `attachments` / `assignedTo` / `contexts` / `tags` / `rev` / 提醒策略字段 / 归档与删除标记 |
| `description` | **只有单任务提醒**带（去 Markdown 后）；摘要、backlog、平台文本里的任务清单都不带 |
| 摘要任务白名单 | 只有 `id` / `title` / `status` / `dueDate` / `startTime` |
| 平台文本条数上限 | 摘要与 backlog 各最多列 **5 条**标题 |
| 链接 | v1.22 起**不再外发任何链接**（旧 `links.app` 已移除：它指向的 Web 任务页打不开，点开是 404） |
| 凭据 | `MINDWTR_TOKEN` / `SMTP_PASS` / `WEBHOOK_SECRET` 从不出现在 body 或日志 |
| URL 脱敏 | 状态库只记 `webhook:N`，日志里的 URL 统一变成 `[url]` |

> **配置实现现状（如实标注）**：`config.channels.privacy.stripFields` 与
> `NOTIFY_DIGEST_WITHOUT_DESCRIPTION` 目前在 `src/config.ts` 里只是**声明**，
> 渲染过程没有读取它们；上面的最小化是 `TaskSummary` / `renderMessage` 的**类型层面硬编码**，
> 因此不受这两个配置值影响。改动渲染逻辑时不要误以为「改配置就能放开字段」。

所有已配置渠道默认一起发送，渠道选择**不会改变 body 内容**：同一条提醒在各渠道收到的是同一份消息（按平台格式渲染）。

---

## 9. 对接方自检清单

1. 先用 `node src/cli.ts --test-webhook` 发一条最小 `event: "test"` 消息验证连通与签名。
2. 验签务必用**原始请求体字符串**；时间偏差超过 5 分钟主动拒绝。
3. 返回 **2xx** 才算成功；若响应是 `{"errcode":...}` 形状，业务码必须为 0（见 §10）。
   其余状态码会被重试（最多 3 次，间隔 200/400ms…）；业务码失败则立即失败、由下一轮调度重投兜底。
4. 自建幂等：用 `event` + `task.id` + `trigger.at` 之类的业务键，别用 `sentAt`。
5. `generic` 通道按 `event` 分支解析，**不要假设 `task` / `digest` 一定存在**；字段缺失是不出现，不是 `null`。
6. 平台适配器收到的是纯文本，不是结构化 JSON；摘要最多 5 条标题，完整清单要走 `generic` 通道。
7. 日志与状态库里看不到 Webhook URL，排障时用 `--log-level=debug` 看渠道短名与请求结果即可
   （见 [配置参考 §9](configuration.md)）。

---

## 10. 业务响应校验（v1.15：别让「200 但 errcode!=0」骗过日志）

企业微信 / 钉钉 / 飞书的机器人**可能用 HTTP 200 表示「请求收到了，但业务上拒绝」**。
例如企业微信 key 失效时返回：

```json
{"errcode":40058,"errmsg":"invalid webhook url"}
```

v1.14 及以前只按 `response.ok` 判定，会把它记成「投递成功」，结果群里没有消息、
状态库也不会留下 `failed` 记录。v1.15 起 `src/dispatch/webhook.ts` 在 HTTP 判定之后再读一次响应体。

### 10.1 识别规则（只认明确的机器人响应，避免误伤自建接收端）

| 字段形状 | 来源 | 判定 |
|---|---|---|
| `{"errcode":0,...}` | 企业微信 / 钉钉 | 成功 |
| `{"errcode":<非 0>,...}` | 企业微信 / 钉钉 | **业务失败** |
| `{"StatusCode":0,"StatusMessage":"..."}` | 飞书新版 | 成功 |
| `{"StatusCode":<非 0>,"StatusMessage":"..."}` | 飞书新版 | **业务失败** |
| `{"code":<非 0>,"msg":"..."}` | 飞书旧版 | **业务失败** |
| 空 body、纯文本、`{"ok":true}`、`{"code":200}`（无消息字段）、非 JSON | 任意 / `generic` 自建接收端 | 没有可识别的业务码，**仍按 HTTP 状态判定** |

只认这三种形状的理由：`generic` 是用户自建接收端，返回 `{"code":200}` 之类自有格式很常见，
无条件把非零 `code` 当失败会误伤；飞书两版都必须**同时带消息字段**才认。

### 10.2 业务失败怎么处理

- 错误信息形如 `Webhook 业务失败：errcode=40058 invalid webhook url`，
  只取 `errmsg` / `msg` 字段、统一过 URL 脱敏并截断，**不会把整个响应体写进状态库或日志**。
- **不即时重试**：无效 key、非法消息格式这类错误是确定性的，重发同一个 body 只会刷群，
  而且 200ms 的退避对企微限流也太短。直接记 `failed`，由下一轮调度（默认 60s）跨轮重投兜底。
- 非 2xx 仍按原逻辑重试；若响应体里也带业务码，错误文本会同时含 HTTP 状态与 `errcode`。
- 三种平台适配器与 `generic` 共用这套逻辑（都在 `postWebhook` 里），`--test-webhook` 也一样。

### 10.3 另一个曾经造成「假成功」的原因（v1.15 一并修复）

`--test-webhook` 在 v1.14 及以前**固定走 `generic` 通用通道**，不看
`NOTIFY_WEBHOOK_ADAPTERS`。也就是说：即使 `.env` 配的是企业微信，测试也会发一份
结构化 JSON + HMAC 头过去，企微很可能回 200 + 业务错误码，而 CLI 仍显示「测试成功」。
现在该命令按第一个 URL 的适配器类型选择与常驻投递**完全相同**的路径，并在结果里打印
适配器名（`Webhook 测试成功（适配器 wecom，第 1 次尝试）。`）。

### 10.4 排障顺序

1. `node src/cli.ts --test-webhook --log-level=debug` —— 看适配器名与具体 `errcode`。
2. 若提示 `errcode` 非 0：查 URL 里的 key 是否失效、消息格式是否被平台接受、
   `NOTIFY_WEBHOOK_ADAPTERS` 是否与 URL 一一对应。
3. 若 `errcode=0` 但群里仍没消息：查机器人是否被移除、是否被限流、群设置是否屏蔽机器人。
4. 业务失败的 `last_error` 可在 `/admin` 管理页查看，详见 [页面操作手册](admin-guide.md)。
