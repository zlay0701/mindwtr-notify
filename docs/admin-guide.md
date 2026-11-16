# Notify 管理页操作手册

> 对应 `spec.md` **v1.25** · 管理页属 M4 / EXT-19 后半【官方无】，是**本地状态库的只读视图**，
> 不重新拉取 Cloud API、不重算触发计划、不改动任何 BASE 规则。
> 部署见 [部署指南](deployment.md)，配置项见 [配置参考](configuration.md)，
> 服务实际调用的云端接口见 [Cloud API 调用清单](cloud-api.md)。

---

## 1. 打开页面

| 场景 | 地址 / 做法 |
|---|---|
| 服务在本机 | 浏览器打开 `http://127.0.0.1:8788/admin` |
| 服务在远程 VPS | 先建 SSH 隧道：`ssh -L 8788:127.0.0.1:8788 <用户>@<VPS 地址> -N`，再在本机浏览器打开上面的地址 |
| 健康检查 | `curl -sS http://127.0.0.1:8788/healthz` |

`compose.yaml` 把端口写成 `127.0.0.1:8788:8788`，**只监听宿主机回环**，
所以 VPS 上从公网直接访问是打不开的，这不是故障。
⚠️ 不要为了省事改成 `0.0.0.0` 或加一层公网反代；用 SSH 转发即可。

页面开关是 `NOTIFY_ADMIN_PAGE`（默认 `true`）。页面 HTML 骨架不含任何运行数据，
因此**打开页面本身不需要鉴权**；但所有数据接口在配置了管理 token 后都需要鉴权。

---

## 2. 顶部栏

| 元素 | 作用 |
|---|---|
| `命名空间：xxx` | 当前实例所属的 `NOTIFY_NAMESPACE`，用来确认自己看的是哪一套状态库 |
| 管理令牌输入框 | 仅当配置了 `NOTIFY_ADMIN_TOKEN` / `HEALTHZ_TOKEN` 时显示；`type=password`，填完自动保存到**当前标签页会话**（`sessionStorage`） |
| 「刷新」按钮 | 重新拉取六个区块的数据 |
| 右侧红色提示 | 显示加载失败原因，例如「未授权：请填写管理令牌后刷新」 |

令牌**不进 URL、不写 localStorage、不进服务端日志**；前端通过 `X-Admin-Token`
（或 `Authorization: Bearer`）请求头发送。关掉标签页即失效。

---

## 3. 鉴权与「为什么数据空白」

- 管理 token 取值顺序：`NOTIFY_ADMIN_TOKEN` → 回退 `HEALTHZ_TOKEN` → 都为空则视为本机可信，**不显示输入框**。
- 配了 token 却没填：所有 API 返回 401，页面显示「未授权：请填写管理令牌后刷新」。
- 每次鉴权失败都会在**审计日志**里记一条 `auth_failed`（只记路径与结果，不记提交的 token 值）。

> `HEALTHZ_TOKEN` 同时会让 `/healthz` 需要 Bearer 鉴权；healthcheck 会自动从环境变量带上该 token，
> 所以配了它容器依然是 `healthy`。手工 curl 时需要加 `-H 'Authorization: Bearer <token>'`。

---

## 4. 六个区块逐项说明

### 4.1 运行概览

一行汇总，格式：

```
已发 N · 失败 N · 待投递 N · 过期跳过 N · 最近一轮计划 N 条 · 重发入口 已启用（需鉴权）/ 已关闭
```

数据来自本地状态库计数 + `/healthz` 同款指标快照。

### 4.2 已发记录

投递**成功**的记录，按更新时间倒序。

| 列 | 含义 |
|---|---|
| 时间 | 记录最后更新时间 |
| 触发类型 | `due` / `start` / `review` / `due-repeat` / 摘要类等 |
| 任务 ID | 云端任务 id |
| 渠道 | `email`、`webhook:0` 等短名（**不存 Webhook URL**） |
| 状态 | `sent` 显示绿色标签 |
| 去重键 | 触发点 + 渠道组成的唯一键，用于排查重复投递 |

### 4.3 失败 / 待重试

把 `failed`、`pending`、`skipped_late` 三类放在一起，便于排障。

| 列 | 含义 |
|---|---|
| 状态 | `failed` 红色、`pending` / `skipped_late` 黄色 |
| 次数 | 已尝试次数 |
| 错误（脱敏） | 失败原因，URL 与 32 位以上长串标识会被隐藏、最多 200 字 |
| 操作 | 「重发」按钮，或显示「未启用」/「需鉴权」 |

`skipped_late` 表示触发点已滑出 BASE-27 的 5 分钟补发窗口，不会再自动补发。

### 4.4 渠道状态

每个渠道**最近一次**投递结果，取自状态库缓存，不会主动探测外部服务。
例：`webhook:0 → sent`、`email → failed`。适合快速判断「是不是只有某个渠道坏了」。

### 4.5 下一批待触发提醒

来自最近一轮计划的缓存（不重新拉云端数据），列：触发时间、触发类型、任务 ID、事件。
用来确认「接下来会发什么」，或核对刚改的配置有没有改变计划。

### 4.6 审计日志

只记录管理操作与鉴权失败，不记录凭据原文。

| 常见 `操作` | 含义 |
|---|---|
| `auth_failed` | 有人带了错误 / 缺失的 token 访问 API |
| `retry_denied` | 尝试调用重发，但重发未启用或缺鉴权 |
| `retry_bad_request` | 重发请求体不是合法 JSON、超 4KB，或缺 `dedupeKey` |
| `retry` | 手动重发，`结果` 列为是否找到并重置了记录 |

`主体` 为 `admin` / `local` / `anonymous`；`详情` 同样经过脱敏。

---

## 5. 手动重发（页面里唯一的写操作）

### 三个前置条件（缺一不可）

1. `NOTIFY_ADMIN_RETRY=true`
2. 配置了 `NOTIFY_ADMIN_TOKEN`（或 `HEALTHZ_TOKEN`）
3. 页面里填入了正确的管理令牌

不满足时，「操作」列会显示「未启用」或「需鉴权」。

### 操作步骤

1. 打开 `/admin`，在顶部「管理令牌」输入框填入 token。
2. 等页面自动刷新（或点「刷新」），确认数据正常显示。
3. 在「失败 / 待重试」区块找到目标记录，点右侧「重发」。
4. 成功后提示「已排队重试：<去重键>」，页面自动刷新；审计日志新增一条 `retry`。

### 重发到底做了什么

**它不会立即发送消息**，只把这条记录在本地状态库里放回「可重试」状态。
下一轮调度仍要按 BASE-27 的**5 分钟补发窗口**判断是否真的投递：
若触发点已过期，`skipped_late` 不会被重新发出。这是为了避免误操作造成历史提醒轰炸。

重发也**不会向 Mindwtr Cloud 发任何请求**，更不会触碰 `/complete` 等写端点。

### 接口返回码

| 码 | 含义 |
|---|---|
| 200 | 已放回可重试状态 |
| 400 | 请求体不是合法 JSON / 超 4KB / 缺少合法 `dedupeKey` |
| 401 | token 缺失或错误 |
| 403 | 重发未启用或缺少鉴权凭据 |
| 404 | 找不到该去重键对应的记录 |

---

## 6. `/healthz` 字段速查

`GET /healthz` 只返回运行指标，不含任务内容、Webhook URL 或任何凭据（`Cache-Control: no-store`）。

| 字段 | 含义 |
|---|---|
| `ok` | 最近一轮是否没有错误（`lastErrorCount === 0`） |
| `lastPollAt` | 上次成功轮询的时间戳（毫秒），未轮询过为 `null` |
| `lastErrorCount` | 最近一轮连续失败次数 |
| `pendingCount` | 状态库中待投递记录数 |
| `channelStatus` | 每个渠道最近一次状态与时间 |
| `lastPlanCount` | 最近一轮算出的计划条数 |

Compose 的 healthcheck 就是用容器内 Bun 请求这个端点，间隔 30s、超时 5s、失败 3 次判 unhealthy。

---

## 7. API 速查

所有 `/admin/api/*` 在配置了管理 token 时都需要鉴权头：

```bash
# 只读接口示例
curl -sS -H 'X-Admin-Token: <管理令牌>' \
  http://127.0.0.1:8788/admin/api/overview

# 手动重发（唯一 POST）
curl -sS -X POST -H 'X-Admin-Token: <管理令牌>' \
  -H 'Content-Type: application/json' \
  -d '{"dedupeKey":"<从失败记录里复制的去重键>"}' \
  http://127.0.0.1:8788/admin/api/retry
```

| 方法 | 路径 | 返回内容 |
|---|---|---|
| GET | `/admin/api/overview` | 命名空间、鉴权/重发状态、计数、healthz 快照 |
| GET | `/admin/api/sent` | 成功记录 |
| GET | `/admin/api/failed` | 失败 / 待投递 / 过期跳过记录 |
| GET | `/admin/api/channels` | 渠道最近状态 |
| GET | `/admin/api/upcoming` | 下一批待触发提醒 |
| GET | `/admin/api/audit` | 审计日志 |
| POST | `/admin/api/retry` | 手动重发（只改本地状态库） |

每个列表最多返回 `NOTIFY_ADMIN_MAX_RECORDS` 条（默认 100，上限 500）。
只读接口只接受 `GET`，重发只接受 `POST`，其余一律 404。
`?token=` 这种把令牌放 URL 的写法**刻意不支持**，避免进浏览器历史与访问日志。

---

## 8. 常见操作场景

| 我想… | 怎么做 |
|---|---|
| 确认容器重启后没有重复发 | 看「运行概览」的计数与「已发记录」是否新增；投递成功数应保持不变 |
| 查某次投递为什么失败 | 在「失败 / 待重试」看「错误（脱敏）」列；需要完整原因再看 `docker compose logs` |
| 判断是不是只有邮件渠道坏了 | 看「渠道状态」：`webhook:0=sent` 而 `email=failed` 就是渠道级独立失败的正常表现 |
| 页面一片空白 / 提示未授权 | 填管理令牌后点「刷新」；仍不行用 §7 的 curl 验证 token 是否正确 |
| 「重发」按钮不出现 | 检查 `NOTIFY_ADMIN_RETRY=true` 与管理 token 是否都配了，改完需重建容器 |
| 担心误触重发 | 默认关闭；且重发只排队、不立即发送，过期触发点也不会补发 |

---

## 9. 安全边界

1. 页面与所有 JSON 都**不含** `MINDWTR_TOKEN`、管理 token、`WEBHOOK_URLS`、`SMTP_PASS` 或任务正文。
2. 错误文本与审计详情展示前会脱敏：URL → `[URL 已隐藏]`、32 位以上长串 → `[长串标识已隐藏]`、截断 200 字。
3. 前端渲染一律用 `textContent`，不拼 HTML，避免注入；页面自包含，不加载任何外部资源。
4. 令牌只存在当前标签页会话，通过请求头传递；不进 URL、不进服务端日志。
5. 唯一的写接口只改本地状态库的一条记录，**对 Mindwtr Cloud 始终只读**。
