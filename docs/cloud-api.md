# Mindwtr Cloud API 调用清单

> 对应 `spec.md` **v1.19**。本文回答一个问题：**Notify 到底会调用 Mindwtr Cloud 的哪些接口？**
> 本文讲的是**入站只读 GET**；服务**出站 POST** 的数据格式见 [Webhook 输出数据格式清单](webhook-payload.md)。
> 按「谁在调用」分四层写清楚，避免把「白名单允许」误当成「服务真的会发」，
> 也避免把开发期探针 / 测试脚本的请求算到产品运行时头上。
>
> 相关文档：[部署指南](deployment.md) · [配置参考](configuration.md) · [页面操作手册](admin-guide.md) ·
> [M0 实测报告](probe-result.md)

---

## 0. 一句话结论

| 层 | 会发请求吗 | 内容 |
|---|---|---|
| **服务运行时**（`src/`，常驻轮询） | ✅ 只发 2 类 | `GET /v1/tasks`（按状态分页）、`GET /v1/projects`（缓存 10 分钟） |
| 产品客户端白名单里**允许但未调用** | ❌ 运行时不发 | `GET /health`、`GET /v1/tasks/:id` |
| 开发期 / 运维脚本 | ✅ 会发，但不是服务行为 | 探针的全量只读探测、测试实例造数、远端探活 |
| **主动禁止 / 不实现** | ❌ 永不发 | 对生产实例的 POST / PUT / PATCH / DELETE、`/complete` 等写端点；`/capture` 不调用 |

**硬约束**：对 Mindwtr Cloud【生产实例】只允许 `GET`，且路径必须在白名单内；
禁止任何写操作，禁止对 `/complete` 等写端点做实测。已授权的唯一例外是
`scripts/seed-test-data.mjs` 在**测试实例**造数（脚本启动硬拒绝生产地址），
产品代码 `src/` 内仍严格只读。

---

## 1. 服务运行时实际发出的请求

调用链固定为：

```
scheduler.runOnce()
  └─ Promise.all([ cloud.fetchActiveTasks(), cloud.fetchProjects() ])   // src/scheduler.ts
       └─ client.get(pathname, params)                                   // src/cloud/client.ts
            ├─ assertReadOnly('GET', pathname)  方法 + 路径双白名单
            └─ fetch(url, { method:'GET', headers, signal: 20s 超时 })
```

**所有对外请求都必须经过 `get()`**；双白名单在发请求之前拦截，不在名单内的方法 / 路径
会直接抛错，HTTP 请求根本不会发出。

| # | 方法 | 路径 | 查询参数 | 何时调用 |
|---|---|---|---|---|
| 1 | `GET` | `/v1/tasks` | `status=<状态>&limit=100&offset=<n>` | 每轮轮询，按状态分别拉取并按 `total` 翻页 |
| 2 | `GET` | `/v1/projects` | `limit=100` | 每轮调用该函数，但**结果缓存 10 分钟**，只有缓存过期才真的发 HTTP |

### 1.1 `GET /v1/tasks` 的细节

- 状态固定为 `inbox` / `next` / `waiting` / `someday` 四个；
  `NOTIFY_INCLUDE_REFERENCE=true` 时再加 `reference`（默认 `false`）。
- `PAGE_SIZE=100`，按响应外壳里的 `total` 累加 `offset` 翻页；
  **每个状态最多 20 页**（`MAX_PAGES`），同页出现重复 id 会提前停止，避免死循环。
- 响应外壳实测为 `{ tasks, total, limit, offset }`；也兼容直接返回数组或 `items` / `data` / `results`。
- 同一任务可能出现在多个状态里，合并时**按 id 去重、`rev` 大者胜出**。
- **不做两段式补查**：M0 实测「列表项字段比详情更全」（列表多 `description` / `projectId` / `recurrence` 等），
  因此不会为了补字段去调 `/v1/tasks/:id`。

### 1.2 `GET /v1/projects` 的细节

- 结果缓存 `PROJECT_CACHE_MS = 10 分钟`，用于项目名与归档过滤。
- 响应外壳实测为 `{ projects, total, limit, offset }`；生产实例 15 条项目。
- 项目列表未见 `reviewAt` / `archivedAt` → 归档项目过滤优先用任务级 `projectArchivedAt`，回退项目 `status`。

### 1.3 请求头与失败处理

| 项 | 值 / 行为 |
|---|---|
| `Authorization` | `Bearer <MINDWTR_TOKEN>`，只放请求头，绝不拼进 URL、日志或异常信息 |
| `Accept` | `application/json` |
| 超时 | 单个请求 `AbortSignal.timeout(20_000)` |
| 非 2xx | 只记 `GET <path> 返回 <status>`，**不回显响应体**（可能含凭据） |
| 连续失败 | 退避 60s → 2min → 4min → 8min，上限 `NOTIFY_MAX_BACKOFF_MS`（默认 10 分钟） |
| 告警 | 连续失败达到 `NOTIFY_FAILURE_ALERT_AFTER`（默认 3）发一次告警，恢复时再发一次通知 |

### 1.4 一轮轮询大概多少次请求

默认 `NOTIFY_POLL_SECONDS=60`，一轮至少 4 次 `GET /v1/tasks`（四个状态各一次），
再加上按 `total` 的翻页。生产实例实测 `next` 状态 568 条分 6 页，
**一轮约 9 次 `GET /v1/tasks`**；`GET /v1/projects` 因缓存约每 10 分钟才 1 次。
失败退避会拉长间隔，不会高频重试打爆上游。

---

## 2. 白名单允许、但运行时并不调用

`src/cloud/client.ts` 的 `assertReadOnly` 允许 4 条路径：

| 方法 | 路径 | 运行时是否发 | 说明 |
|---|---|---|---|
| `GET` | `/health` | ❌ | 客户端里定义了 `health()` 方法，但**全项目没有任何调用点**，常驻轮询不会探活 |
| `GET` | `/v1/tasks` | ✅ | 见 §1.1 |
| `GET` | `/v1/tasks/:id` | ❌ | 白名单放行（正则 `^/v1/tasks/[^/]+$`），但列表字段已足够，M0 结论是「不需要两段式补查」 |
| `GET` | `/v1/projects` | ✅ | 见 §1.2 |

> 另外，开发期探针 `scripts/probe.mjs` 的白名单比产品客户端多两条：
> `/openapi.json` 与 `/swagger.json`。这两条**不在产品客户端白名单内**，
> 且实测带 token 仍返回 401，拿不到 schema（见 [M0 报告 §6](probe-result.md)）。
> 两者都属于「探针试过」，不是服务行为。

---

## 3. 开发期 / 运维脚本会调用的接口

这些请求**不是产品服务的运行行为**，只在人手动执行脚本时发生。

### 3.1 M0 只读探针 `scripts/probe.mjs`（一次性字段探测，全部 GET）

| 方法 | 路径 | 实测结果 |
|---|---|---|
| `GET` | `/health` | 200 `{"ok":true}`，免认证 |
| `GET` | `/v1/tasks?status=<状态>&limit=100&offset=<n>` | 200，四状态按 `total` 翻页；生产实例合计 595 条 |
| `GET` | `/v1/tasks/:id` | 200，返回弱 ETag `W/"mindwtr-entity-sha256-…"` |
| `GET` | `/v1/projects?limit=100` | 200，15 条项目 |
| `GET` | `/openapi.json`、`/swagger.json` | **401**（带 token 仍 401） |
| `GET` | `/v1/tasks?status=next&limit=1`（**不带 token** 的对照） | **401** |

完整记录见 `docs/probe-result.md`。探针同样是「方法 + 路径」双白名单，从不发写请求。

### 3.2 测试实例造数 `scripts/seed-test-data.mjs`（用户显式授权的例外）

| 方法 | 路径 | 请求体 / 说明 |
|---|---|---|
| `GET` | `/v1/tasks?all=1&limit=100` | 先查已存在的 `[NotifyTest]` 任务，按标题幂等 |
| `PATCH` | `/v1/tasks/:id` | **扁平字段**（如 `{"dueDate":"…"}`），把已造任务的时间滚动到相对当前 |
| `POST` | `/v1/tasks` | `{"title":"…","props":{"status":"next","dueDate":…,"startTime":…,"reviewAt":…}}` → 201 |

约束：脚本启动就硬检查 `MINDWTR_BASE_URL`，**指向生产地址直接拒绝**；
不碰 `/complete`、不 `DELETE`、不写文件、不输出 token 与任务正文。
时间字段必须是带 `T` 时间的 ISO 字符串（BASE-21）；仅日期 `YYYY-MM-DD` 不产生任务级触发点（BASE-22）。

### 3.3 部署联调脚本 `scripts/deploy-test.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | 测试实例 `/health` | 远端 `curl` 探活，确认 VPS 能连到 Cloud（实测 200 / 0.11s） |

### 3.4 端到端联调 `tests/e2e-channels.mjs`

**不发任何真实 Cloud 请求**：把 `MINDWTR_BASE_URL` 临时指向本机 mock、
`MINDWTR_TOKEN` 覆盖成假值，只连 `127.0.0.1` 的本地服务。

---

## 4. 主动不调用 / 明确禁止

| 方法 · 路径 | 状态 | 原因 |
|---|---|---|
| `POST /v1/tasks/:id/complete` | **代码存在，但默认永不发** | `src/actions/complete.ts` 需同时打开 `NOTIFY_ALLOW_WRITE=true` 与 `NOTIFY_COMPLETE_ACTION=true` 才构造请求，且 CLI / Scheduler / Dispatcher **都没有调用点**；按只读约束主动不做实测 |
| `POST /v1/capture` | 不调用 | 只创建 Inbox 文本任务、不带时间字段；capture-only token 只能调它，本项目需要完整 bearer token |
| 对生产实例的 `POST` / `PUT` / `PATCH` / `DELETE` | **禁止** | 用户硬约束；产品客户端的 `get()` 只发 GET，双白名单在发请求前拦截 |
| `PUT` / `DELETE /v1/tasks/:id` | 未实现、未调用 | — |
| `/openapi.json` / `/swagger.json` | 运行时不调用 | 只有探针试过且 401 |
| 内网直连 `http://<cloud 容器名>:8787` | 可选、未实测 | `compose.yaml` 里保持注释，默认走公网 HTTPS；容器随机名重建后会变 |

> 关于 `If-Match`：官方只在 **PATCH** 上写明支持乐观锁；`/complete` 是否支持未经确认。
> 本服务纯只读，用不上 `If-Match`（详情返回的弱 ETag 也只是 M0 的实测记录）。

---

## 5. 认证与响应要点（排障速查）

| 现象 | 结论 |
|---|---|
| 不带 token 访问 `/v1/tasks` | **401** |
| 用 capture-only token 访问 `/v1/tasks`、`/v1/projects` | **403**（该 token 只能 `POST /v1/capture`） |
| `/health` | **免认证** 200 `{"ok":true}`；本机经代理约 1.7–2.0s，VPS 直连约 0.11s |
| 列表响应 | `{ tasks, total, limit, offset }`；项目是 `{ projects, total, limit, offset }` |
| 详情响应 | 弱 ETag；**字段比列表少**，所以不需要详情补查 |
| 时间字段 | 条件性字段：任务没设 `dueDate` / `startTime` / `reviewAt` 就不会出现在响应里 |
| 生产实例「计划 0 条」 | 595 条活跃任务全无时间字段，任务级提醒本就不触发；**不是 bug**，摘要类仍按时刻发 |
| 测试实例数据 | 会被客户端同步整体覆盖，造的 `[NotifyTest]` 可能消失；重跑造数脚本即可（幂等、从不 DELETE） |

---

## 6. 想自己核对时（全部只读、安全）

```bash
# 1) 免认证探活
curl -sS https://<你的-cloud-域名>/health

# 2) 看产品客户端的双白名单与统一 GET 封装（唯一权威位置）
#    src/cloud/client.ts → assertReadOnly() / get()

# 3) 看一轮里谁发起了调用
#    src/scheduler.ts → Promise.all([fetchActiveTasks(), fetchProjects()])

# 4) 看历史实测的请求逐条记录
#    docs/probe-result.md
```

❌ 不要做：对生产实例发写请求、为了「更真实」把联调脚本改成直连生产、
用裸 `docker compose config` 校验（会打印含 token 的 env_file 明文）、把 token 贴进命令或日志。
