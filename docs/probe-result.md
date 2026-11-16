# M0 字段探针报告 · Notify

- 生成时间：2026-11-13T11:55:21.494Z
- 目标：`https://mindwtr-cloud.zlay.dpdns.org`
- 模式：完整（已提供令牌）
- 只读保证：全部请求为 `GET`，路径限 `/health`、`/v1/tasks`、`/v1/tasks/:id`、`/v1/projects`、`/openapi.json`、`/swagger.json`；不含任何写操作。
- 凭据：只从 `MINDWTR_TOKEN` 环境变量或本地 `.env` 读取，不写入报告、日志或云端。
- 隐私：报告不含任务标题、描述、附件、负责人、标签等正文内容。

> ⚠️ **这是 2026-11-13 生产实例的历史快照**，下文「项目未见 `reviewAt`」「任务全无时间字段」等结论只对当时数据成立。
> 测试实例自 v1.29 起已有带 `reviewAt` 的项目并完成项目回顾端到端验证（见 `HANDOFF.md` §4 第 31 条）；
> 规则与当前基线以 `spec.md`（v1.30）和 `HANDOFF.md` 为准。

## 1. 连通性与鉴权

- `GET /health` → **200**，1636ms，响应 `{"ok":true}`
- 不带令牌访问 `GET /v1/tasks` → **401** ({ "error": "Unauthorized" })

## 2. 活跃任务（按 total 翻页拉全）

| 状态 | 页数 | total | 实取 | 停止原因 | 首页结构 |
|---|---|---|---|---|---|
| inbox | 1 | 24 | 24 | exhausted | object(keys=tasks,total,limit,offset; paging=total,limit,offset) |
| next | 6 | 568 | 568 | exhausted | object(keys=tasks,total,limit,offset; paging=total,limit,offset) |
| waiting | 1 | 0 | 0 | exhausted | object(keys=tasks,total,limit,offset; paging=total,limit,offset) |
| someday | 1 | 3 | 3 | exhausted | object(keys=tasks,total,limit,offset; paging=total,limit,offset) |

- 合计取回 595 条活跃任务；列表响应未返回 ETag。

## 3. 列表项 vs 任务详情

- `GET /v1/tasks/:id` → **200**，671ms；ETag：W/"mindwtr-entity-sha256-565702dc5459127d2b357a73af2d237f2dc8c07e7459b868a033edabf23a0625"
- 仅详情有的字段：无
- 仅列表有的字段：`checklist`, `description`, `projectId`, `order`, `orderNum`, `priority`, `recurrence`, `recurrence.byMonthDay`, `recurrence.rrule`, `recurrence.rule`, `recurrence.seriesId`, `recurrence.strategy`, `recurrence.byDay`, `sectionId`, `areaId`
> 若「仅详情有的字段」为空，说明列表字段已足够，M1 无需两段式补查。

## 4. 项目列表

- `GET /v1/projects` → **200**，810ms，15 条；结构：object(keys=projects,total,limit,offset; paging=total,limit,offset)
- 观察到的字段：`areaId`, `areaTitle`, `color`, `createdAt`, `id`, `isFocused`, `isSequential`, `order`, `rev`, `revBy`, `status`, `supportNotes`, `tagIds`, `title`, `updatedAt`

## 5. 规则引擎所需字段

| 字段 | 列表有 | 详情有 | 样本形状 | 说明 |
|---|---|---|---|---|
| `id` | 有 | 有 | string(len=36) |  |
| `status` | 有 | 有 | string(len=5) |  |
| `dueDate` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `startTime` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `reviewAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `dueReminderLeadMinutes` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `startReminderLeadMinutes` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `repeatReminderMinutes` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `reminderPolicy` | 有 | 有 | string(len=7) |  |
| `suppressMindwtrReminders` | 有 | 有 | boolean |  |
| `cancelledAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `completedAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `deletedAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `archivedAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `projectArchivedAt` | 无 | 无 | - | 全量样本中未出现（可能是条件性字段） |
| `projectId` | 有 | 无 | string(len=36) |  |
| `rev` | 有 | 有 | number |  |
| `description` | 有 | 无 | string(len=20) |  |

列表项观察到的全部字段（来自全部活跃任务，按字母序）：

`areaId`, `checklist`, `contexts`, `createdAt`, `description`, `id`, `isFocusedToday`, `order`, `orderNum`, `priority`, `projectId`, `pushCount`, `recurrence`, `recurrence.byDay`, `recurrence.byMonthDay`, `recurrence.rrule`, `recurrence.rule`, `recurrence.seriesId`, `recurrence.strategy`, `reminderPolicy`, `rev`, `revBy`, `sectionId`, `status`, `suppressMindwtrReminders`, `tags`, `taskMode`, `title`, `updatedAt`


时间字段格式分布（用于验证 BASE-21 的 `/[T\s]\d{2}:\d{2}/` 判定）：

| 时间字段 | 出现次数 | 仅日期 | 带时间 | 其他格式 | 样本 |
|---|---|---|---|---|---|
| `dueDate` | 0 | - | - | - | 无样本 |
| `startTime` | 0 | - | - | - | 无样本 |
| `reviewAt` | 0 | - | - | - | 无样本 |
| `cancelledAt` | 0 | - | - | - | 无样本 |
| `completedAt` | 0 | - | - | - | 无样本 |

## 6. API 描述文档

- `GET /openapi.json` → **401**，547ms
- `GET /swagger.json` → **401**，1514ms
- 两者带令牌仍返回 401，说明它们不由本 bearer token 保护（或位于另一层鉴权之后），拿不到 schema；字段结论只能依据实测样本 + 官方源码。

## 7. 结论

- **是否需要两段式补查：否（基于全量活跃任务样本）**
- 全量样本中仍未出现的字段：`dueDate`, `startTime`, `reviewAt`, `dueReminderLeadMinutes`, `startReminderLeadMinutes`, `repeatReminderMinutes`, `cancelledAt`, `completedAt`, `deletedAt`, `archivedAt`, `projectArchivedAt`
- 观察到带时间部分的日期：否
  - 全量 595 条活跃任务中没有任何带截止/开始/回顾时间的任务，**当前数据下只有摘要类提醒会触发**，任务级提醒不会产生触发点。
  - 这不是 API 缺陷：这些字段是条件性的，任务没设时间就不会出现。类型定义按官方 `task-sync-schema.ts` 声明为可选，M1 规则引擎用单元测试覆盖。
  - 建议在客户端给一条测试任务设置明确的截止时间后重跑本探针，即可端到端验证 `hasTimeComponent` 的真实存储格式（BASE-21）。
- M1 拉取策略：按 `total` 用 `limit/offset` 翻页，合并按 id 去重；列表字段已足够，不调用详情接口。
- 归档项目过滤：项目列表未见 `archivedAt` / `reviewAt`，优先用任务级 `projectArchivedAt`，回退项目 `status`。
- 仍需人工确认：compose 服务名 / 端口 / 网络名，以及所有同步客户端是否为较新版本。

## 请求清单

| # | 用途 | 方法 | 路径 | 状态 | 耗时(ms) | ETag |
|---|---|---|---|---|---|---|
| 1 | health | GET | `/health` | 200 | 1636 | - |
| 2 | auth-check (no token) | GET | `/v1/tasks?status=next&limit=1` | 401 | 2284 | - |
| 3 | tasks:inbox:page1 | GET | `/v1/tasks?status=inbox&limit=100&offset=0` | 200 | 580 | - |
| 4 | tasks:next:page1 | GET | `/v1/tasks?status=next&limit=100&offset=0` | 200 | 897 | - |
| 5 | tasks:next:page2 | GET | `/v1/tasks?status=next&limit=100&offset=100` | 200 | 865 | - |
| 6 | tasks:next:page3 | GET | `/v1/tasks?status=next&limit=100&offset=200` | 200 | 1249 | - |
| 7 | tasks:next:page4 | GET | `/v1/tasks?status=next&limit=100&offset=300` | 200 | 1090 | - |
| 8 | tasks:next:page5 | GET | `/v1/tasks?status=next&limit=100&offset=400` | 200 | 1377 | - |
| 9 | tasks:next:page6 | GET | `/v1/tasks?status=next&limit=100&offset=500` | 200 | 1036 | - |
| 10 | tasks:waiting:page1 | GET | `/v1/tasks?status=waiting&limit=100&offset=0` | 200 | 626 | - |
| 11 | tasks:someday:page1 | GET | `/v1/tasks?status=someday&limit=100&offset=0` | 200 | 1722 | - |
| 12 | task detail | GET | `/v1/tasks/9d841b69-6341-42b2-a990-adffe8ee68b5` | 200 | 671 | W/"mindwtr-entity-sha256-565702dc5459127d2b357a73af2d237f2dc8c07e7459b868a033edabf23a0625" |
| 13 | projects | GET | `/v1/projects?limit=100` | 200 | 810 | - |
| 14 | api-doc:/openapi.json | GET | `/openapi.json` | 401 | 547 | - |
| 15 | api-doc:/swagger.json | GET | `/swagger.json` | 401 | 1514 | - |

> 本报告不含任务正文与任何凭据。
