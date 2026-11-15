# HANDOFF · 新对话窗口交接包

> 生成时间：2026-11-13 · 最后整理：2026-11-15 23:20（v1.17 GitHub 仓库与 CI）· 对应 `spec.md` **v1.17**
> 用途：在**新对话窗口**继续开发 Notify，不必携带前面几十轮对话的历史。
> 本文件自包含：读完它 + 按需查 `spec.md` 对应章节即可开工。
>
> ⚠️ **当前环境（2026-11-15 核实）**：`.env` 的 `MINDWTR_BASE_URL` 指向**测试服务器**
> `https://mindwtr-cloud.zlay.cc.cd`（生产是 `...zlay.dpdns.org`）。**两个实例都正常**，
> 测试服务器 `/health` 经系统代理返回 200 `{"ok":true}`；`npm test` 恒 **85/85**（v1.15 起）；
> 用 §7 的代理前缀跑 `dry-run` 得到 **14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**
> （到点数随造数时间衰减；生产实例基线是 595 条 / 15 个项目 / 计划 0 条）。
> ⚠️ **本机坑**：命令行 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量指向 `127.0.0.1:48020`，
> 而浏览器 / .NET 用的系统代理是 `127.0.0.1:7897`；Node `fetch` 默认不读代理变量，
> 于是直连被 `ECONNRESET`、`dry-run` 变成「0 条 + `fetch failed`」。**不是服务端故障、不是代码缺陷**，
> 见 §4 第 13 条与 §7 的正确运行方式。VPS 部署不经过本机代理，无需改产品代码。

---

## 0. 三十秒上手

1. 在**同一个工作区** `C:/Users/admin/WorkBuddy/2026-11-13-17-14-33` 里新开对话窗口。
   同一工作区会自动带上 `.workbuddy/memory/` 里的项目记忆，但**以本文件为准**。
2. 把 §1 的提示词整段复制过去，把 `<本次目标>` 换成 §1 目标表 / §5 清单里的一项。
3. 让 AI 先跑 §7 的基线命令，确认没跑偏，再开始改代码。
4. 窗口结束前让它按 §9 回写文档，然后关窗口 —— 下一个目标再开新窗口。

---

## 1. 可直接复制的开工提示词

### 通用模板

```
继续开发 Notify（Mindwtr 提醒服务）。工作区：C:/Users/admin/WorkBuddy/2026-11-13-17-14-33。

第一步：读 HANDOFF.md（交接包，包含全部已确认事实与硬约束）。
需要规则细节时只查 spec.md 的对应章节，不要通读 50KB 全文；文件职责查 README.md。

硬约束（长期生效，不必再问我）：
1. 对 Mindwtr Cloud【生产实例】只能发 GET，且路径必须在白名单内；禁止 POST/PUT/PATCH/DELETE，
   禁止对 /complete 等写端点做任何实测。token 只在本机 .env，不写日志、报告、代码或聊天输出。
   已授权的例外：当前 .env 指向测试服务器，可用 npm run seed:test 造数据（脚本自带非生产地址硬检查）；
   产品代码 src/ 内仍严格只读。详见 HANDOFF §2。
2. 所有代码方便人类阅读 + 必要中文注释：文件头说明职责，导出函数说明用途/参数/返回值，
   复杂判断解释「为什么」；每个规则函数标注 BASE-xx / EXT-xx 编号与三态标记
   【一致】/【增强】/【官方无】。
3. 不改动 BASE 基线规则；新增触发点类扩展默认关闭，strict 模式必须能一键回到 100% 一致。

本次目标：<替换为 §1 目标表 / §5 清单里的一项>。

开工前先跑 npm test 与 npm run dry-run 确认基线（npm test 应为 85/85；dry-run 取决于 .env 指向的实例：
测试服务器约 14 条任务 / 1 个项目 / 计划 4 条，到点数随造数时间衰减；生产实例 595 条任务 / 15 个项目 / 计划 0 条；
全程只读）。数字对不上先读 HANDOFF §3 / §7 判断是不是数据或时间变化，别急着改代码。
完成后按 HANDOFF.md §9 回写 spec.md、工作日志与本文件的进度/未完成清单。
不要顺手做目标之外的事；遇到需要我提供的凭据或授权，一次性列出来问，不要分多轮补料。
```

### 可选目标（把上面 `<本次目标>` 换掉；A–E 均已完成，保留作历史）

| # | 目标（复制这段） | 前置条件 | 预估 |
|---|---|---|---|
| **A** | ✅ **已完成（v1.3）** —— 补齐与官方 `getTaskReminderPlan` 的**黄金数据集合比对夹具**：`tests/official-schedule.ts` + `tests/official-golden.test.ts`，strict 差集为空 | 无（保留作历史，勿重复做） | — |
| **B** | ✅ **已完成（v1.7，2026-11-15）** —— 真实渠道端到端联调：邮件实发 / Webhook 验签 / 渠道级独立重试 / 重启不重复投递，四项全过，见 `spec.md` §12.1 | 无（保留作历史，勿重复做） | — |
| **C** | ✅ **已完成（v1.4）** —— 开发 **M4**：只读管理页 + 多命名空间隔离，按 `spec.md` §14 验收 | 无（保留作历史） | — |
| **D** | ✅ **已完成（v1.8，2026-11-15）** —— VPS 部署联调：起服务、挂卷持久化、healthz 探活、真实投递一轮、重启不重复投递，全部通过，见 §4 第 14 条 | 无（保留作历史，勿重复做） | — |
| **E** | ✅ **已完成（v1.9，2026-11-15）** —— compose / Dockerfile 生产化补齐：`healthcheck`、`read_only: true` + `tmpfs`、生产镜像剔除 `scripts/`、新增 `.dockerignore`，远端真实 Docker 验证通过，见 §4 第 15 条与 `spec.md` §12.3 | 无（保留作历史，勿重复做） | — |

> 已完成：**A（v1.3）**、**C（v1.4）**、**带时间任务端到端验证（v1.5）**、**交付物整理（v1.6）**、
> **B 真实渠道端到端联调（v1.7）**、**D VPS 部署联调（v1.8）**、**E 生产化补齐（v1.9）**。
> **五个目标全部完成**；剩余仅 `complete` 写端点实测（与只读约束冲突，主动不做）与内网直连验证（可选），见 §5。

---

## 2. 硬约束（不要在新窗口里重新讨论）

| 约束 | 内容 |
|---|---|
| **只读云端** | 对**生产实例** `https://mindwtr-cloud.zlay.dpdns.org` 只允许 `GET`，路径需在白名单（产品客户端 `src/cloud/client.ts` 为 `/health`、`/v1/tasks`、`/v1/tasks/:id`、`/v1/projects` 四条；M0 探针另含 `/openapi.json`、`/swagger.json`）。**运行时实际只发 `GET /v1/tasks`（按状态分页）与 `GET /v1/projects`（缓存 10 分钟）两类**；`/health` 与 `/v1/tasks/:id` 白名单允许但无调用点，完整清单见 `docs/cloud-api.md`。禁止任何写操作。`src/actions/complete.ts` 是唯一涉及写端点的代码，默认**永不触发**。**2026-11-14 显式例外**：用户切到测试服务器并授权造数，`scripts/seed-test-data.mjs` 只向测试实例发 `POST /v1/tasks` / `PATCH /v1/tasks/:id`；产品代码 `src/` 内严格只读，脚本启动硬检查生产地址即拒绝，`/complete` 仍未实测。 |
| **凭据** | `MINDWTR_TOKEN` 只在本机 `.env`（32 字符，值从未写入任何日志/报告/聊天）。capture-only token 不可用（在 `/v1/tasks` 会 403）。`.gitignore` 已排除 `.env`。 |
| **代码规范** | 人类可读优先、必要中文注释、规则函数标注编号 + 三态标记。这条是用户明确要求的长期默认，不用再提醒。 |
| **基线不可污染** | `BASE-01…29`【一致】规则恒生效、不可关闭；新增触发点类扩展（EXT-16/17/18）默认 `enabled: false`；`strict_mode: true` 强制回到 100% 一致。EXT-19 后半的 M4 管理页 / 命名空间不产生触发点，故不属于需默认关闭的 A 类；但手动重发入口默认关闭且强制鉴权。 |
| **单实例** | `replicas: 1`，无 leader election；起两个副本会重复发送。 |

---

## 3. 进度快照（2026-11-15 13:50 整理）

| 里程碑 | 状态 | 备注 |
|---|---|---|
| **M0** 实测探针 | ✅ 完成 | `docs/probe-result.md` 为权威实测结论 |
| **M1** 一致核心 | ✅ 已实现（含官方比对夹具，验收通过） | 无遗留；比对中纠正 2 处与官方不一致（review 单一策略、due-repeat 单一策略） |
| **M2** 摘要与渠道 | ✅ 已实现 | **真实渠道端到端联调（目标 B）+ VPS compose 部署联调（目标 D）2026-11-15 均已通过** |
| **M3** 可选增强 | ✅ 已实现 | 标签路由 + 钉钉/企微/飞书适配器 + 双向完成只读闸门；`complete` 写端点**主动不实测** |
| **M4** 管理页 | ✅ 已实现（验收通过） | 只读管理页 + 三层命名空间隔离 + 受鉴权重发 + 审计；`spec.md` §14 全部勾选 |

**基线数字**：`npm test` **85/85 通过**（M1 14 + M2 20 + M3 12 + 黄金/回归 5 + M4 11 + v1.13 日志 12 + v1.15 业务响应 11），纯本地、不随所连实例变化。
`npm run dry-run`（全程只读、未投递未写库）：
- **生产实例**：595 条任务 / 15 个项目、strict 计划 0 条（数据全无时间字段）。
- **当前测试实例**：本次整理实测 **14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**
  （造数在 09:21，22:05 时 4 个触发点已滑出 BASE-27 的 5 分钟补发窗口）。
  刚跑完 `npm run seed:test` 的几分钟内是「到点 1 条」；重跑脚本即可恢复，幂等不增数据。
- 生产实例曾有一次 dry-run 因 Cloud API 瞬时超时拉到 0 条，复跑即恢复 595/15，非代码缺陷。

**端到端验证（2026-11-14）**：测试实例 + 本地假 Webhook 响应跑通「计划 → 投递 → 渠道级成败 → 去重 → 管理页 → 受鉴权重发 → 审计」，详见 `spec.md` v1.5 与 `.workbuddy/memory/2026-11-14.md`。

**交付物整理（2026-11-14 22:05，v1.6）**：本次只改文档、不动代码。把过时的 dry-run 数字改为
「实例 + 时间」双维度的动态表述，重排 §5 未完成清单（新增纯本地可做的目标 E），补齐文件地图与常见坑。

**目标 B 真实渠道端到端联调（2026-11-15，v1.7）**：新增 `tests/e2e-channels.mjs`，
用本地 mock Cloud + 真实 SMTP + 本地独立验签接收端 + 三个独立进程跑完四项验收，全部 PASS：
邮件实发（2 封）、HMAC 验签（5 次请求含错密钥 / 篡改正文对照）、
轮 1 邮件成功而 Webhook 失败重试 3 次、轮 2 只重投 Webhook、轮 3 零投递零请求。
期间修复 `src/dispatch/email.ts` 多行 EHLO 丢行导致真实 SMTP 挂起的缺陷。
`npm test` 恒 62/62；收尾 `dry-run` 用正确代理复跑为 **14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**
（先前 0 条 / `fetch failed` 是本机代理配置问题，见头部与 §4 第 13 条）。

**目标 D VPS 部署联调（2026-11-15，v1.8）**：用户授权上传含凭据 `.env` 后，
用独立项目名 `notify-test` / 卷 / `127.0.0.1:8789:8788` 起单副本服务，
`/healthz` 与 `/admin` 均 200、卷挂载 `/app/data` 持久化、造数后真实投递一轮
（本地 Webhook 独立验签通过）、第二次重启零投递零请求，四项全过。
VPS 出站 SMTP 587/465 被拒属网络策略，联调阶段临时关闭 SMTP 投递并改用本地 Webhook，
凭据仍完整注入容器。执行器 `scripts/deploy-test.py`；容器已停、测试卷保留，详见 §4 第 14 条。
收尾 `dry-run`（造数刚刷新）为 **14 条任务 / 1 个项目、计划 4 条、到点 1 条、过期跳过 0 条**。

**目标 E 生产化补齐（2026-11-15，v1.9）**：纯配置改动，`src/` 一行未动。`compose.yaml` 补 `healthcheck`
（镜像自带 Bun 请求 `/healthz`、兼容 `HEALTHZ_TOKEN`、避开 `${}` 插值）与 `read_only: true` + `tmpfs /tmp`；
`Dockerfile` 去掉 `COPY scripts`；新增 `.dockerignore` 统一排除 `.env` / `scripts/` / `data/`；
`remote.py` 同步白名单加入它，`deploy-test.py` 改为读取它作为单一事实来源。
远端真实 Docker 验证：`config --quiet` 通过、镜像 `/app` 只剩 `package.json / src / data`、
容器 `HEALTH=healthy` + `READONLY=true` + 卷与 `/tmp` 可写，验证后 `down` 清理。
`npm test` 恒 62/62；收尾 `dry-run` 为 **14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**。
详见 §4 第 15 条与 `spec.md` §12.3。

**v1.10 缺陷修复与清理（2026-11-15 14:50）**：新增 `src/errors.ts` 统一错误信息归一化，
修掉 Bun 下空 `error.message` 写空串、以及异常文本里含密钥的 Webhook URL 落库两类问题；
healthcheck 的 `HEALTHZ_TOKEN` 分支完成端到端验证（401 / 200 / healthy）；
远端联调残留（含真实凭据 `.env`、override、接收端）全部删除，容器与网络已移除、测试卷保留。
`npm test` 本地与远端均 62/62、远端 `docker build` 成功；详见 §4 第 16 条与 `spec.md` §12.4。

**v1.11 运维文档交付（2026-11-15 15:32）**：纯文档，不动代码与规则。新增
`docs/deployment.md`（Compose 部署与运维）、`docs/configuration.md`（全量配置参考）、
`docs/admin-guide.md`（`/admin` 页面操作手册）；补齐 `.env.example` 的
`NOTIFY_DIGEST_WITHOUT_DESCRIPTION`；`README.md` 新增文档导航、`HANDOFF.md` §6 同步文件地图。
`npm test` 仍 62/62。

**v1.12 Cloud API 调用清单（2026-11-15 20:14）**：新增 `docs/cloud-api.md`，按四层写清楚
「运行时实际调用 / 白名单允许但未调用 / 开发期与运维脚本 / 主动禁止」。
核实结论：产品运行时只发 `GET /v1/tasks`（四状态按 `total` 翻页，生产实例实测约 9 次/轮）与
`GET /v1/projects`（缓存 10 分钟，实际约每 10 分钟 1 次）；`health()` 定义了但全项目无调用点，
`/v1/tasks/:id` 因列表字段更全不做两段式补查。`deployment.md` 加 §1.1 摘要，
四份文档头部版本统一到 v1.12，`README.md` 导航与 §6 文件地图同步。纯文档改动，`npm test` 仍 62/62。

**v1.13 可配置日志级别（2026-11-15 20:45，EXT-20【官方无】）**：新增 `src/logger.ts`，
`NOTIFY_LOG_LEVEL=debug|info|warn|error|silent`（默认 `info`）控制运行时诊断日志，
`--log-level=debug` 可临时覆盖；`errors.ts` 补 `redactUrls` 供日志与状态库共用；
scheduler / cloud / healthz 全面接入分级，debug 能看到每个 Cloud GET 的路径、状态、耗时、
计划条数、逐条触发点决策与渠道投递结果。命令输出（dry-run 计划、投递结果、配置错误）始终可见。
新增 12 个用例，`npm test` 本地与远端均 **74/74**，远端 `docker build` 与禁网 Bun 镜像冒烟通过。
详见 §4 第 17 条与 `spec.md` §12.5。

**v1.14 Webhook 输出数据格式清单（2026-11-15 21:15）**：纯文档。新增 `docs/webhook-payload.md`，
按「传输层 / 完整字段表 / 14 种 event / JSON 样例 / 验签头 / 三平台适配器 / 隐私边界 / 对接自检」
统计全部出站 POST 格式；所有样例由本地假数据实跑生成，不联网、不发 Webhook。
顺带修正 `docs/configuration.md` §5「三个平台各有签名」的不准确表述（**企业微信无签名**），
并如实标注 `privacy.stripFields` / `NOTIFY_DIGEST_WITHOUT_DESCRIPTION` 目前只是配置声明、
渲染层并未读取，数据最小化实际是类型层面硬编码。四份文档头部版本统一到 v1.14，
`README.md` 导航与目录结构、`HANDOFF.md` §6 同步。`npm test` 仍 74/74。

**v1.15 Webhook 业务响应校验（2026-11-15 22:35）**：改产品代码，`src/` 里的 BASE / strict 基线零改动。
`src/dispatch/webhook.ts` 在 HTTP 判定之后新增业务码校验，识别企微 / 钉钉 `errcode` 与飞书
`StatusCode` / `code`，解决「200 但 `errcode!=0`」被误报成功；空 body、纯文本、非 JSON、
自建接收端普通 JSON 不误伤。业务失败**不即时重试**（确定性错误重发只会刷群），
记 `failed` 由跨轮重投兜底；错误只取 `errmsg` / `msg` 并脱敏截断。
另修 `src/cli.ts` 的 `--test-webhook`：此前固定走 `generic`、不看 `NOTIFY_WEBHOOK_ADAPTERS`，
配了企微却发结构化 JSON，是另一类「假成功」根因；现在与常驻投递同路径并显示适配器名。
新增 11 个用例，`npm test` 本地与远端均 **85/85**，远端 `docker build` 与禁网 Bun 冒烟通过；
真实企业微信实测「适配器 wecom，第 1 次尝试成功」（发 1 条测试消息）。
详见 §4 第 18 条与 `spec.md` §12.6。

**v1.16 Coolify 部署教程（2026-11-15 22:55）**：纯文档 + 一份编排文件，`src/` 一行未动。
新增 `docs/coolify.md` 与 `compose.coolify.yaml`；后者把 `env_file` 换成 `${VAR}` 白名单、
去掉 `container_name` / `ports`，并故意不注入两个云端写开关。
已在目标 VPS 只读核对 **Coolify 4.7.5 / Traefik 3.7**，并用真实 Docker Compose 验证编排语法
与 `${MINDWTR_TOKEN:?}` 必填约束；**未实际创建 Coolify 资源或部署**。
`npm test` 仍 85/85。详见 §4 第 19 条与 `spec.md` §12.7。

**v1.17 GitHub 公有仓库与 CI（2026-11-15 23:20）**：纯文档 + 一个工作流文件，`src/` 一行未动。
用户明确要求「以后所有改动都提交到 `zlay0701/mindwtr-notify`，不许提交敏感信息」，
已写入用户级与项目级 MEMORY.md。完成全量敏感审计（比对 `.env` 真实值）、
`.gitignore` 加固、白名单 `git add` 首次提交 52 个文件、新增 `.github/workflows/ci.yml`
（单测 / 镜像构建 / 编排校验 / no-secrets 防呆）。
⚠️ **仓库尚未创建**：GitHub 连接器 App 无权建仓（403），本机 GCM 凭据对 API 401，
需用户在网页创建空的公有仓库后再推送。详见 §4 第 20 条与 `spec.md` §12.8。

---

## 4. 已确认的实测事实（不要重复花积分探测）

1. **列表响应外壳**是 `{tasks, total, limit, offset}`；分页按 `total` 翻页，`next` 状态 568 条分 6 页，inbox 24、waiting 0、someday 3，合计 **595 条**。
2. **列表项字段比详情更全**（列表多 `description` / `projectId` / `recurrence` 等），详情**没有**独有字段 → **不需要两段式补查**，M1 只拉列表。
3. **ETag**：列表无；详情返回弱 ETag `W/"mindwtr-entity-sha256-…"`。纯只读用不上 `If-Match`。
4. **`/openapi.json`、`/swagger.json` 带 token 仍 401**，拿不到 schema；字段结论只能靠样本 + 官方源码。`/v1/openapi.json` 是 404。
5. ⚠️ **生产实例 595 条活跃任务里没有任何一条带 `dueDate` / `startTime` / `reviewAt`**，提醒参数字段也全无。这些是条件性字段——任务没设时间就不会出现在响应里。**所以生产数据下任务级提醒不会产生任何触发点，只有摘要类会发**，dry-run 计划 0 条是正常现象，不是 bug。端到端验证已在测试服务器用 `npm run seed:test` 造 5 条带时间任务完成（见第 10 条），不必再改客户端任务。
6. **项目列表 15 条**，未见 `reviewAt` / `archivedAt` → 归档项目过滤优先用任务级 `projectArchivedAt`，回退项目 `status`。
7. `/health` 免认证返回 `{"ok":true}`，约 1.7–2.0s（经 Cloudflare 代理）；三个 `/v1` 端点无 token 均 401。
8. **运行环境**：本机 Node **v22.22.2**、**未装 Bun**、无 Docker。Node 22 原生类型剥离可直接 `node file.ts` / `node --test`，所以项目**零运行时依赖、无需编译**；生产镜像仍按选型用 `oven/bun:1.3-alpine`。`node:sqlite` 在本机是实验特性，会有 `ExperimentalWarning`，不影响功能。
9. **连接信息**：默认走公网 `https://mindwtr-cloud.zlay.dpdns.org`。VPS 上是面板生成的容器（名 `mindwtr-cloud-<随机ID>`）与外部网络 `rifyenhfmtws99c3pea0zu4d`（Attachable: true）；内外端口均为 8787。内网直连需 `external: true` 且用**完整容器名**，且随机名重建后会变 —— 所以 compose 里那段保持注释、默认走公网。`spec.md` §10 有完整结论。
10. **测试服务器与写端点（2026-11-14 实测，仅测试实例）**：`.env` 可切到 `https://mindwtr-cloud.zlay.cc.cd`（`/health` 200；库内容会变，见第 11 条）。
    `POST /v1/tasks` 创建用 `{"title":"...","props":{"status":"next","dueDate":"...","startTime":"...","reviewAt":"..."}}` → **201**；
    `PATCH /v1/tasks/:id` 用**扁平字段**（`{"dueDate":"..."}`，与官方 `cancelledAt` 示例同构）→ **200**；
    `POST /v1/capture` 用 `{transcription}` 或 `text/plain` → 201、支持 `captureId` 幂等，但**不带时间字段**，不适合造提醒样本。
    时间字段必须是带 `T` 时间的 ISO 字符串（BASE-21）；仅日期 `YYYY-MM-DD` 不产生任务级触发点（BASE-22）。
    服务端会给新任务补 `reminderPolicy: "inherit"`。官方文档见 `docs.mindwtr.app/developers/cloud-api` 与 `/power-users/capture-webhook`；
    `/openapi.json`、`/swagger.json` 在测试实例同样 404。
11. **测试库会被客户端同步覆盖（2026-11-14 实测）**：上午造的 5 条 `[NotifyTest]` 到中午查询时全部消失，
    库变成 9 条无时间字段任务 / 1 个项目；重跑 `npm run seed:test` 后又写入 5 条，晚间为 14 条任务 / 1 个项目。
    结论：测试服务器的数据**不可依赖**，每次开工先只读查一次 `GET /v1/tasks?all=1`；
    `[NotifyTest]` 没了就重跑造数脚本，不要误判成代码删了数据（脚本从不发 DELETE）。
12. **远程 Linux 构建环境已打通（2026-11-15 实测）**：`.env` 新增 `SSH_URI`
    （`ssh://用户名@主机:端口`，**不含密码**），远端 `SSH-2.0-instabox` 接受 `none` 认证，
    用户名即一次性凭证，不需要密码或本机私钥；运维脚本因此不读取 `~/.ssh`。
    该机就是跑 `mindwtr-cloud` 的 VPS（Coolify 面板）：Debian 13、Node v22.23.3、Bun 1.4.4、
    Docker 29.9.3、Compose v5.7.1，8788 空闲、可用磁盘 5.0G、可拉公网镜像。
    实测远端 `npm test` **62/62**、`docker build` 成功（`mindwtr-notify:remote-test`，147MB）、
    禁网冒烟能加载 `src/rules/reminder-plan.ts`（11 个导出）。
    ⚠️ 现有 Cloud 容器名后缀已变为 `szj4zxoghn8jrdm0hghsqhu0`，与第 9 条记录的随机 ID 不同，
    **再次印证容器重建后名字会变，内网直连不可依赖**。
    运维脚本 `scripts/remote.py` 只做 check/sync/test/build/smoke，**不启动容器、不上传 `.env`**。
13. **目标 B 真实渠道联调与 SMTP 缺陷修复（2026-11-15）**：
    - **本机代理坑（上午曾误判为「服务端 TLS 故障」，12:23 核实更正）**：服务端一直正常，
      `/health` 经 .NET / 浏览器（系统代理 `127.0.0.1:7897`）返回 **200 `{"ok":true}`**，生产实例同样 200。
      但命令行环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 指向的是**另一个代理** `127.0.0.1:48020`：
      该代理 CONNECT 隧道能建成（200 Connection Established）却随后 TLS 握手失败
      （`curl` 报 35 schannel，`curl -k` / `--ssl-no-revoke` 均无效），直连则 `Connection was reset`。
      而 **Node `fetch` 默认不读代理环境变量**，所以 `dry-run` 直连被 `ECONNRESET` →
      「0 条任务 / 0 项目 + `fetch failed`」。**不是服务端故障、不是代码回归**，别改 BASE 规则。
      本机开发期解法（仅临时环境变量，不改 `.env` / 不改代码，VPS 部署不需要）：
      `HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 https_proxy=... http_proxy=... NODE_USE_ENV_PROXY=1 npm run dry-run`
      （`NODE_USE_ENV_PROXY=1` 是 Node 22 实验特性，会打印 `[UNDICI-EHPA] Warning`，无害）。
      复跑结果：**14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**，与 §3 基线一致。
    - `.env` 的 SMTP 是 Resend Relay（587 + STARTTLS）。首次 `node src/cli.ts --test-email` 挂死：
      `src/dispatch/email.ts` 的 `createLineReader` 在没有等待者时丢弃已到达的行，
      而 EHLO 多行响应常在单个 data 事件里一次性到达 → 等不到结束行 → 永久挂起。
      已改为缓存未读行（`pendingLines`），真实发信恢复正常，`npm test` 仍 62/62。
      ⚠️ 以后改 SMTP 读取逻辑，别再引入「没有 `readLine()` 等待者就丢行」的写法。
    - 联调方式：本地 mock Cloud（1 条 `startTime` 为 1 分钟前的任务，落在 BASE-27 窗口内）
      + 本地 Webhook 接收端（独立实现 HMAC，含错密钥 / 篡改正文对照）+ 三个独立 `--once --strict` 进程
      共用一个持久状态库。**不连任何真实云端**，`MINDWTR_TOKEN` 临时覆盖成假值，
      状态库放系统临时目录 + 命名空间 `e2elocal`，不污染 `data/`。
      四项验收全部 PASS，详见 `spec.md` §12.1 与 `.workbuddy/memory/2026-11-15.md`。
14. **目标 D VPS 部署联调（2026-11-15，v1.8）**：用户授权上传含 `MINDWTR_TOKEN` / `SMTP_PASS` 的 `.env`。
    - 安全落地：凭据只从本地 `.env` 读入内存、经 SFTP 写远端 `/data/home/notify-test/app/.env`（权限 600），
      **过滤掉 `SSH_URI`**（本机运维串，与容器无关）；额外写 `.dockerignore` 排除 `.env` 与 `scripts/*.py`。
      compose 校验只用 `docker compose config --quiet`，绝不用会展开 env_file 明文的 `docker compose config`。
    - 隔离：项目名 `notify-test`、容器 `notify-test-app`、端口 `127.0.0.1:8789:8788`、
      卷 `notify-test_notify-data`、网络 `notify-test_default`，单副本，未触碰任何已有容器。
    - 实测：`up -d --build` 成功；`/healthz` 与 `/admin` 均 200（`lastErrorCount=0`）；
      卷挂载 `/app/data`；造数刷新后第一次重启「计划 4 / 到点 1 / **成功 1 失败 0**」，
      本地 Webhook 接收端 `HOOK sig_ok=true fresh=true`、`HOOK_HITS=1`、状态库 `sent:1`；
      第二次重启「成功 0」、`HOOK_HITS` 仍 1、状态库计数不变 → **跨重启去重生效**。
    - ⚠️ **VPS 出站 SMTP 587 / 465 均 `ECONNREFUSED`**（宿主机直连同样如此，属网络策略，非代码缺陷）。
      联调阶段在 `compose.override.yaml` 临时设 `SMTP_ENABLED=false` + `WEBHOOK_ENABLED=true`，
      并在同网络起 `hook-receiver` 完成真实投递；**SMTP 凭据仍完整注入容器**，未来放行端口即可启用。
      目标 B 已在本机用真实 SMTP 验证过邮件实发，两条链路互补。
    - ✅ **v1.10 已修复**：Bun 下空 `error.message` 写空串的问题由 `src/errors.ts` 的
      `describeError` 统一兜底；顺带修掉异常文本里含密钥的 Webhook URL 落库（见 §4 第 16 条）。
    - 收尾：`docker compose -p notify-test down` 已移除容器与网络，**测试卷保留**；
      远端含凭据 `.env` 与联调 override 已于 v1.10 删除（可由 `deploy-test.py prepare` 重新生成）。
      执行器 `scripts/deploy-test.py`，详见 `spec.md` §12.2 与 `.workbuddy/memory/2026-11-15.md`。
15. **目标 E 生产化补齐（2026-11-15，v1.9）**：本机无 Docker / Bun，改用远端真实 Docker 验证。
    - `compose.yaml`：`healthcheck` 用镜像自带 Bun 请求 `/healthz`（不依赖 alpine 是否装 curl/wget），
      `HEALTHZ_TOKEN` 非空时从环境变量构造 Bearer 头，token 不进 compose 也不进 `docker inspect`；
      脚本刻意用字符串拼接而非模板字面量，避免 `${...}` 被 Compose 插值。
      `read_only: true`（EXT-15【官方无】）配 `tmpfs /tmp:size=16m,mode=1777`，唯一可写位置是卷 `/app/data` 与 `/tmp`。
    - `Dockerfile` 不再 `COPY scripts`；新增根目录 `.dockerignore` 排除 `.env` / `scripts/` / `tests/` /
      `data/` / `compose.override.yaml` / `hook-receiver.mjs`，构建上下文实测仅 942B。
    - `scripts/remote.py` 白名单加入 `.dockerignore`；`scripts/deploy-test.py` 删掉内置 `DOCKERIGNORE` 常量，
      改为 `dockerignore_text()` 读取本地文件，排除规则只维护一份。
    - 实测：`config --quiet` 退出 0 零输出；镜像 `/app` = `data/ package.json src/`，`SCRIPTS_DIR=NO`、
      `.mjs/.py` 0 个、`ENV_FILE=NO`，禁网冒烟 11 个导出；隔离容器 `HEALTH=healthy`（两次检查退出码 0）、
      `READONLY=true`、根文件系统 `touch` 失败、`/app/data` 与 `/tmp` 可写、SQLite WAL 齐全、
      `/healthz` 与 `/admin` 均 200。
    - healthcheck 的 `HEALTHZ_TOKEN` 非空分支已于 v1.10 完成端到端验证（见 §4 第 16 条）：
      服务端开鉴权时不带 token 401、带 token 200，healthcheck 仍 `HEALTH=healthy`、`READONLY=true`。
    - ⚠️ **未改 `.env`**：`MINDWTR_BASE_URL` 仍指向测试实例。本轮不部署，切回生产会立刻改变 dry-run 基线；
      已把这一步固化为 `compose.yaml` 头部与 `README.md` 的部署前检查清单
      （连同移除联调 override、用 `config --quiet` 校验、确认单副本）。
    - 收尾 `down`：容器与网络移除、测试卷保留；v1.10 已删除远端 `.env`（600，含真实凭据）、
      联调 override、临时鉴权层与接收端，部署目录只剩源码与 `.dockerignore`。
16. **v1.10 缺陷修复与清理（2026-11-15）**：改产品代码但不动 BASE / strict 基线。
    - 新增 `src/errors.ts` 的 `describeError`：`||` 非空兜底、`https?://\S+` → `[url]`、截断 160 字。
      `src/dispatch/{index,webhook}.ts`、`src/scheduler.ts`、`src/cli.ts` 统一接入；
      `src/cloud/client.ts` 的 `summarizeError` 改为委托（导出签名不变）。
      修掉两类问题：Bun 下 socket 错误 `message` 为空 → `sent_log.last_error` 空白；
      fetch/SMTP 异常文本带含密钥的 Webhook URL → 直接落库/打日志。
    - healthcheck 鉴权端到端：临时 `compose.auth.yaml` 注入假 `HEALTHZ_TOKEN` 起实例，
      `NO_TOKEN_HTTP=401`、`WITH_TOKEN_HTTP=200`、`ADMIN_HTTP=200`、
      `HEALTH=healthy`（退出码 0 0）、`READONLY=true`；验证后 `down` 并删除该临时文件。
    - 远端清理：删除 `.env` / `compose.override.yaml` / `compose.auth.yaml` / `hook-receiver.mjs`，
      `NO_CONTAINERS` / `NO_NETWORK`，测试卷 `notify-test_notify-data` 保留；
      重新 `sync` 后部署目录只剩 `compose.yaml / Dockerfile / .dockerignore / .env.example / package.json / scripts / src / tests`。
    - 验证：本地与远端 `npm test` 均 **62/62**（回归断言加进现有用例，数量不变）、远端 `docker build` 成功；
      禁网镜像内 `EMPTY_FALLBACK=未知错误`、`ERROR_FALLBACK=未知错误`、`URL_MASKED=fetch failed: [url]`、
      `SUMMARIZE_EMPTY=未知错误`、`DISPATCH_EXPORTS=3`。
    - 收尾 `dry-run`：**14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**，全程只读。
17. **v1.13 可配置日志级别（2026-11-15，EXT-20【官方无】）**：改产品代码，BASE / strict 基线零改动。
    - 配置：`NOTIFY_LOG_LEVEL` 五级（默认 `info`），大小写容错；`.env` 写非法值回退 `info` 并打 `WARN`，
      命令行 `--log-level=` 非法值直接报错退出 1；CLI 覆盖优先级高于环境变量。
      启动信息会显示「日志级别=xxx」，方便确认是否生效。
    - 输出：`时间 [级别] [notify] 消息 key=value`；时间按 `NOTIFY_TIMEZONE` 渲染，
      debug/info 走 stdout、warn/error 走 stderr。正文与字段统一过 `redactUrls`。
    - 诊断点：Cloud GET 路径 / 查询参数 / 状态 / 耗时 / 网络异常、项目缓存、退避、
      每轮计划条数、逐条触发点的窗口决策与渠道去重 / 投递结果。
      **不含** token、密码、Webhook URL、任务标题 / 正文；`/healthz?token=` 的查询串不进日志。
    - 兼容性：`SchedulerDeps` 保留 `log` 单函数注入且优先，只转发 info 及以上，
      所以 v1.12 的 62 个旧用例行为完全不变；`createCloudClient` / `startHealthz` 的 logger 参数都是可选末位参数。
    - 命令输出通道：`--dry-run` / `--once` / `--test-*` / `--help` / 配置错误仍直接 console，
      **不受级别过滤**（silent 下也照常输出）。`info` 模式 dry-run 与 v1.12 逐字一致。
    - 验证：`npm test` 本地与远端 **74/74**、远端 `docker build` 成功、禁网 Bun 镜像内
      `FORMAT` / `REDACTED` / `NO_SECRET` / `INFO_ONLY_COUNT` / `PARSE` / `CONFIG_DEFAULT_LEVEL` 全通过；
      只读 dry-run 在 debug / silent / 非法值三种情况下均符合预期。
18. **v1.15 Webhook 业务响应校验（2026-11-15）**：改产品代码，BASE / strict 基线零改动。
    - `src/dispatch/webhook.ts` 新增 `parseWebhookBusinessError` / `readBusinessError` /
      `formatBusinessError`；只认 `errcode`（企微 / 钉钉）、`StatusCode` + `StatusMessage`
      （飞书新版）、`code` + `msg`（飞书旧版）三种形状，避免误伤 `generic` 自建接收端的
      `{"code":200}`。响应体只读前 4KB，读不出来返回 null，不把已成功的 HTTP 倒扣成失败。
    - `postWebhook`：2xx 且无业务错误 → 成功；2xx 有业务错误 → **立即失败、不即时重试**
      （确定性错误重发只会刷群），记 `failed` 由下一轮调度跨轮重投兜底；
      非 2xx 仍按 `WEBHOOK_MAX_ATTEMPTS` 退避重试，错误文本附带 `errcode`。
    - `src/cli.ts` 的 `--test-webhook` 改为按第一个 URL 的适配器类型选择
      `deliverPlatformWebhook` 或 `deliverWebhook`，与常驻投递同路径；输出显示适配器名。
      此前固定发 `generic` 结构化 JSON，配了企微也会显示「测试成功」但群里没消息。
    - 错误文本形如 `Webhook 业务失败：errcode=40058 invalid webhook url`，
      只取 `errmsg` / `msg`，过 `redactUrls` 并截断，不把整个响应体写进状态库 / 日志。
    - 验证：本地与远端 `npm test` 均 **85/85**、远端 `docker build` 成功、禁网 Bun 镜像内
      `ERRCODE_ZERO_IS_NULL=true` / `ERRCODE_BAD=40058` / `MASKED=true` / `NO_SECRET=true` /
      `POST_200_BUSINESS_FAIL=true ATTEMPTS=1`；真实企微 `--test-webhook` 输出
      「适配器 wecom，第 1 次尝试成功」、退出 0，向群发 1 条测试消息（已获授权）。
    - 文档：`docs/webhook-payload.md` 新增 §10、`docs/configuration.md` 新增 §4.7.1
      「三层重试 + attempts 列含义」、`docs/deployment.md` 故障表加「显示成功但没收到消息」，
      五份 docs 头部版本统一到 v1.15。
19. **v1.16 Coolify 部署教程（2026-11-15）**：纯文档 + 一份编排文件，产品代码零改动。
    - 只读探查目标 VPS：`coolify 4.7.5`、`coolify-proxy traefik:v3.7`、Docker 网络 `coolify`、
      8788 / 8789 空闲、无 notify 容器；`/data/coolify/source/.env` 在该沙箱下不可见（不影响教程）。
    - 新增 `docs/coolify.md`：强调「Notify 是纯出站服务」→ 默认不配域名、不发布端口、
      单副本且关闭 PR 预览；必须走 **Git 仓库 + Docker Compose Build Pack**（`build: .` 需要源码上下文，
      「Docker Compose Empty」不适用）、不要启用 Raw Compose Deployment；
      Base Directory = 仓库根、Docker Compose Location = `/compose.coolify.yaml`；
      附一份**不带行尾注释**的可粘贴环境变量清单（项目 `.env` 解析器不处理行尾注释）。
    - 新增 `compose.coolify.yaml`：`${VAR}` 白名单（凭据只在 Coolify 面板）、`${MINDWTR_TOKEN:?}`
      必填、无 `env_file` / `container_name` / `ports`；保留 `read_only` / `tmpfs` / 卷 /
      `healthcheck` / `replicas: 1`；**故意不注入** `NOTIFY_ALLOW_WRITE` / `NOTIFY_COMPLETE_ACTION`。
    - 远端真实 Compose 验证：缺 token → `config --quiet` 退出 1 并报 required variable；
      注入假 token → 退出 0，渲染结果保留 `read_only=true`、`tmpfs`、卷、`replicas:1`、`healthcheck`。
    - ⚠️ Coolify 版**没发布宿主端口**，宿主机 `curl 127.0.0.1:8788` 不通；
      探活要在容器内用 `bun -e` 或 Coolify Terminal，管理页临时访问需按容器 IP 做 SSH 转发。
      教程已按此写，别沿用原生部署的回环端口做法。
    - **本次未创建 Coolify 资源、未部署、未发任何渠道消息**；教程里明确标注哪些命令会真发消息。
20. **v1.17 GitHub 公有仓库与 CI（2026-11-15）**：纯文档 + 一个工作流文件，`src/` 一行未动。
    - 用户长期要求：**所有改动提交到 `zlay0701/mindwtr-notify`（public, main），绝不提交敏感信息**；
      已写入用户级 `MEMORY.md` 与项目 `.workbuddy/memory/MEMORY.md`。
    - 敏感审计：从 `.env` 取 11 个真实值（含 Webhook URL 的 `key` 参数）对 54 个候选文件做子串比对，
      只输出文件名与键名。结论：除公开 Cloud 域名 / 公共 SMTP 主机名外无任何命中；
      `deploy-test.py` 与 `e2e-channels.mjs` 里的假密钥不等于真实值。
      `.env` / `data/`（SQLite + 测试邮件）/ `.workbuddy/`（工作记忆）全部排除。
    - `.gitignore` 加固：新增 `.workbuddy/`、联调产物（`compose.override.yaml` /
      `compose.auth.yaml` / `hook-receiver.mjs`）、`__pycache__/`、`*.pyc`、私钥 / 证书 / SQLite。
      本地 `git init -b main`、noreply 作者、白名单 `git add`，首次提交 **52 个文件**。
    - 新增 `.github/workflows/ci.yml`：`npm test`（Node 22）、`docker build` + 禁网镜像冒烟、
      镜像不含 scripts/.env、`compose.coolify.yaml` 与 `compose.yaml` 的 `config --quiet` 校验、
      **no-secrets 防呆 job**（禁止 `.env` / 状态库 / 工作记忆 / 密钥文件、禁止带值凭据键）。零密钥。
    - ⚠️ **仓库尚未创建**：GitHub 连接器 `POST /user/repos` 返回 403
      `Resource not accessible by integration`（App 无建仓权限）；
      `GET /repos/zlay0701/mindwtr-notify` 为 404；本机 `git credential` 凭据对 API 返回 401。
      **需用户在 GitHub 网页创建空的公有仓库**（不勾 README / LICENSE），之后即可推送并触发 CI。
    - 仓库不可用期间，用 `git archive HEAD` 导出与仓库一致的白名单内容做等价远端验证。

---

## 5. 未完成清单（按优先级；已完成项列在表后）

| 优先 | 事项 | 状态 / 为什么没做 | 需要什么 |
|---|---|---|---|
| 1 | ~~compose / Dockerfile 生产化补齐（目标 E）~~ | ✅ **2026-11-15 已完成（v1.9）**：`healthcheck` / `read_only: true` / `tmpfs` 落地、生产镜像剔除 `scripts/`、新增 `.dockerignore`，远端真实 Docker 验证通过，见 §4 第 15 条与 `spec.md` §12.3 | 无（部署前按 `compose.yaml` 头部清单把 `MINDWTR_BASE_URL` 切回生产地址即可） |
| 2 | ~~真实 SMTP / Webhook 实发（目标 B）~~ | ✅ **2026-11-15 已完成**：四项验收全过，见 §4 第 13 条与 `spec.md` §12.1 | 无 |
| 3 | ~~VPS `docker compose up` 联调（目标 D）~~ | ✅ **2026-11-15 已完成**：四项验收全过，见 §4 第 14 条与 `spec.md` §12.2 | 无 |
| 4 | `complete` 端点实测与 If-Match 验证 | **与只读约束冲突，主动不做**；官方也只在 PATCH 上写了 If-Match | 用户单独授权 + 冲突评审记录 |
| 5 | 内网直连连通性验证（可选） | `spec.md` §10 / §11 仍挂 `- [ ]`；网络名 / 容器名 / 端口已拿到但没实测，按约定默认走公网 HTTPS，可不打勾 | 若要内网直连，需在 VPS 上确认容器名与外部网络 |

> **已完成**：目标 A 黄金比对夹具（v1.3）、目标 C / M4（v1.4）、带时间任务端到端验证（v1.5）、交付物整理（v1.6）、
> **B 真实渠道端到端联调（v1.7）**、**D VPS 部署联调（v1.8）**、**E 生产化补齐（v1.9）**、远程 Linux 构建链路打通（均为 2026-11-15）。
> 表格里只剩第 4 项（`complete` 端点实测，与只读约束冲突、主动不做）与第 5 项（内网直连，可选），都不是代码缺陷。
> `npm test` 恒 85/85；收尾 `dry-run` 为 **14 条任务 / 1 项目 / 计划 4 条 / 到点 0 条 / 过期跳过 4 条**。
> 本机若见 0 条 / `fetch failed` 先查代理，别误判服务端，见头部与 §4 第 13 条。
> 签名、重试、去重、补发、strict 隔离与命名空间隔离逻辑均已用本地单测 + 测试实例端到端覆盖。

---

## 6. 文件地图（详见 `README.md`）

| 文件 | 职责 |
|---|---|
| `spec.md` | **唯一权威规则来源**。§0 里程碑总览 / §1–9 公共规格 / §10–14 里程碑 / §15–18 BASE+EXT 清单与验收矩阵 |
| `HANDOFF.md` | 本文件，新窗口交接 |
| `README.md` | 项目速览、命令、目录结构、约束 |
| `docs/cloud-api.md` | v1.12：Mindwtr Cloud API 调用清单（运行时 / 白名单允许但不用 / 探针与造数脚本 / 主动禁止，含参数、频率、认证与响应要点） |
| `docs/coolify.md` | v1.16：Coolify 部署教程（Git 源 + Compose Build Pack、环境变量白名单、域名与鉴权、卷/副本/预览、常见坑） |
| `compose.coolify.yaml` | v1.16：Coolify 专用编排（`${VAR}` 注入、无 env_file/container_name/ports，只读写开关故意不暴露） |
| `docs/webhook-payload.md` | v1.14：**出站** Webhook 数据格式清单（通用 `generic` 完整字段表、14 种 event 与 JSON 样例、验签头、钉钉/企微/飞书 body、重试与幂等、隐私边界） |
| `docs/deployment.md` | v1.11：Docker Compose 部署与运维指南（§1.1 附接口摘要，含环境变量两条通道、升级回滚备份、故障排查、安全边界） |
| `docs/configuration.md` | v1.11：全量配置参考（优先级 / 启动校验 / 三态标记 / Webhook 验签协议 / 典型样例） |
| `docs/admin-guide.md` | v1.11：`/admin` 页面操作手册（鉴权 / 六块视图 / 手动重发 / healthz 与 API 速查） |
| `docs/probe-result.md` | M0 脱敏实测报告 |
| `scripts/probe.mjs` | 只读字段探针（Node 18+ 零依赖、GET+路径双白名单、报告不含标题/描述/凭据） |
| `scripts/seed-test-data.mjs` | 测试实例造数（非生产地址硬检查、按标题幂等、只发 POST /v1/tasks 与 PATCH /v1/tasks/:id；产品代码仍只读） |
| `scripts/remote.py` | 远程 Linux 运维助手（check/sync/test/build/smoke）。none 认证、凭据脱敏、上传白名单排除 `.env`；建连阶段有限重试 + keepalive；**不启动容器、不发邮件**，详见 §4 第 12 条 |
| `scripts/deploy-test.py` | 目标 D 部署联调执行器（prepare/up/verify/down/status）。凭据内存 SFTP 上传并过滤 `SSH_URI`、隔离项目名与卷、校验只用 `config --quiet`；详见 §4 第 14 条 |
| `src/config.ts` | env 优先加载、A 类默认关、5 分钟补发窗口、校验；M4 增加 `NOTIFY_NAMESPACE` 与 JSON `namespaces.<ns>` 分段配置 |
| `src/errors.ts` | v1.10 新增：错误信息归一化（`\|\|` 非空兜底、去 http(s) URL、截断 160 字），供 dispatch / scheduler / cloud / cli 共用；v1.13 导出 `redactUrls` 供日志复用 |
| `src/logger.ts` | v1.13：EXT-20 分级日志（五级、时区时间戳、URL 脱敏、结构化字段、可注入 sink / now） |
| `src/cloud/client.ts` | 只读 Cloud 客户端：`total` 翻页、`rev` 合并、项目缓存、失败退避 |
| `src/types.ts` | 任务/项目/触发点类型（字段按实测声明为可选，因为条件性字段会缺席） |
| `src/rules/reminder-plan.ts` | **【一致】BASE 规则引擎纯函数**，`hasTimeComponent` / 提前量日历日算术 / `min(8, floor(120/interval))` / `reminderPolicy` 五态 / 归档项目过滤 |
| `src/rules/time.ts` | Intl 时区换算（本地↔UTC 双次偏移） |
| `src/rules/plan.ts` | 统一计划：BASE 任务级 + 三类摘要 + A 类扩展 + strict 隔离 |
| `src/rules/tag-policy.ts` | 【官方无】标签路由（M3），只过滤渠道、不改写触发计划 |
| `src/state/namespace.ts` | M4：命名空间规范化、去重键 `ns=<ns>:` 前缀、状态库路径派生 |
| `src/state/store.ts` | SQLite WAL、`sent_log`、渠道级去重、`bun:sqlite` / `node:sqlite` 适配；M4 加 `namespace` 列（旧库无损迁移）、记录查询 / 计数 / 重试 / 审计接口 |
| `src/admin.ts` | M4：只读管理页 HTML + 6 个 JSON 接口、恒定时间鉴权、脱敏、受双开关保护的 `POST /admin/api/retry` |
| `src/dispatch/*` | 消息渲染与隐私裁剪、SMTP、HMAC 签名 Webhook+重试、钉钉/企微/飞书适配器、渠道级分发器 |
| `src/actions/complete.ts` | 【官方无】双向完成只读闸门（默认永不发写请求） |
| `src/scheduler.ts` | 轮询、5 分钟补发、失败告警与恢复；`upcoming()` 只读计划缓存供管理页展示 |
| `src/healthz.ts` / `src/cli.ts` | 健康端点（不含任务内容与令牌）+ `/admin` 路由委托与共享鉴权 / 全部 CLI 入口 |
| `tests/*.test.ts` | 8 个文件、85 个用例（M4 11 个 + v1.13 日志 12 个 + v1.15 业务响应 11 个） |
| `tests/e2e-channels.mjs` | 目标 B 真实渠道联调执行器：本地 mock Cloud + 真实 SMTP + 独立验签接收端 + 三轮独立进程；不进 `npm test` 用例集，详见 §4 第 13 条 |
| `tests/logging.test.ts` | v1.13：级别过滤 / 格式 / 脱敏 / 配置覆盖 / 调度与 Cloud 集成，12 个用例 |
| `tests/webhook-response.test.ts` | v1.15：业务码解析、200 + errcode 失败不重试、兼容与脱敏、wecom 适配器链路，11 个用例 |
| `package.json` | npm 脚本（零运行时依赖）：`test` / `dry-run` / `once` / `start` / `probe` / `seed:test` |
| `Dockerfile` / `compose.yaml` | Bun 1.3 镜像（只 COPY `package.json` + `src/`）/ `replicas: 1`、`healthcheck`、`read_only: true` + `tmpfs`、healthz 只映射回环、头部部署前检查清单 |
| `compose.coolify.yaml` | v1.16：Coolify 专用编排，见上方文件地图条目 |
| `.github/workflows/ci.yml` | v1.17：零密钥 CI（单测 / 镜像构建 / 编排校验 / **no-secrets 敏感文件防呆**） |
| `scripts/agent-git.sh` | 2026-11-15：以 `Notify Agent` 身份执行 git 命令，让助手提交与所有者提交在历史里可区分；只覆盖本次命令，不改 `.git/config` |
| `.dockerignore` | 构建上下文排除规则的单一事实来源：排除 `.env` / `scripts/` / `tests/` / `data/` 与联调文件，防止凭据与造数脚本进镜像 |
| `.env.example` / `.gitignore` | 配置模板 / 凭据排除规则 |
| `.workbuddy/memory/` | 项目长期约定 `MEMORY.md` + 按天 append-only 工作日志（同一工作区换窗口会自动带入） |

**三个容易忽略的设计决策**：
- 摘要用「触发窗口 + 按天去重」而不是「当前分钟 == 配置分钟」，避免 60 秒轮询错过整分钟。
- 渠道名固定 `email` / `webhook:0`，**不把含密钥的 Webhook URL 写进数据库**。
- 默认命名空间 `default` 的去重键**不加前缀**，旧库记录仍能命中；只有非默认命名空间才加 `ns=<ns>:` 前缀，所以 M4 升级不会重发历史提醒。

---

## 7. 基线验收命令（每个新窗口开工先跑）

```bash
npm test                # 期望 85/85 通过（含官方比对夹具 + M4 11 个 + 日志 12 个 + 业务响应 11 个），纯本地、与实例无关
npm run dry-run         # 测试实例：约 14 条任务 / 1 个项目 / 计划 4 条；到点数随造数时间衰减
                        # 生产实例：595 条任务 / 15 个项目 / 计划 0 条。均应提示未投递未写库
node src/cli.ts --dry-run --strict --log-level=debug  # 排障：打印完整诊断链路，不用改 .env
npm run seed:test       # 仅测试服务器：幂等滚动 5 条 [NotifyTest] 的时间；指回生产地址会被硬拒绝
node src/cli.ts --test-email   # 无 SMTP 时落盘 data/test-emails.txt（配好则真实发信）
node tests/e2e-channels.mjs    # 目标 B 四项验收；只连本机 mock Cloud，会真实发出邮件
```

⚠️ **本机开发期需显式指定正确代理**（命令行环境变量指向 `127.0.0.1:48020`，不可用；
系统代理是 `127.0.0.1:7897`；Node `fetch` 默认不读代理变量，直连会被 RST）：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
NODE_USE_ENV_PROXY=1 npm run dry-run
```

只影响本机命令行，不改 `.env`、不改代码；VPS 部署走公网直连，不需要这些变量。
若看到「0 条 + `fetch failed`」，先按 §4 第 13 条排查代理，别误判服务端或 BASE 规则。
两个实例 `/health` 均 200；切回生产地址可恢复 595 条任务 / 15 个项目、计划 0 条。

`dry-run` 的数字取决于 `.env` 的 `MINDWTR_BASE_URL` **和造数距今多久**，先确认这两点再判断有没有跑偏；
`npm test` 与实例无关。别在错基线上叠加改动。

⚠️ `[NotifyTest]` 的时间相对「造数时刻」生成：刚造完是「计划 4 条 / 到点 1 条」，数小时后变成
「计划 4 条 / 到点 0 条 / 过期跳过 4 条」（BASE-27 的 5 分钟补发窗口）。重跑 `npm run seed:test`
即可滚动回去，脚本幂等、不会重复创建。测试库还可能被客户端同步整体覆盖，见 §4 第 11 条。

---

## 8. 新窗口怎么开最省积分

1. **一个窗口只做一个目标**：从 §1 目标表 / §5 清单选一项贴进开工提示词，做完就关。长会话的历史上下文每轮都重复计费，可达短线会话的 2–4 倍。
2. **让 AI 读文件，不要你粘贴历史**：`HANDOFF.md` + `spec.md` 指定章节就够了；明确写「不要通读 spec 全文」。
3. **同一工作区开窗口**：`.workbuddy/memory/MEMORY.md`（项目约定）和当天日志会自动带过来，不用重复交代。
4. **模型用中档**：写测试、改名、格式化这类活别开 Max / Auto 顶配（公开口径里分别是 ≈3 倍和 5–15 倍消耗）。
5. **一次性把料给全**：凭据、探针输出、compose 信息一次贴齐，避免多轮补料。
6. **用 `--dry-run` / `--once` 自测**，别靠逐轮看日志调试；纯本地能验证的优先做，别先做要等凭据的联调。
7. **每窗口收尾按 §9 回写**，把结论沉淀进文件，下个窗口就不用重新推理。
8. 参考预算：目标 E 50–100 分、A 100–200 分、B/D 各 150–300 分、C 250–450 分；积分按月清零不结转，建议集中在一个月内做完。

---

## 9. 每个窗口收尾要回写的内容

- `spec.md`：更新头部版本号 + 对应里程碑章节的状态 / 任务清单勾选 / 验收结果；§0 总览表同步。
- `.workbuddy/memory/YYYY-MM-DD.md`：**追加**（append-only，不要覆盖），记关键决策、实测数字、遗留项。
- `HANDOFF.md`：更新 §3 进度快照与 §5 未完成清单；若 §4 出现新的实测事实也补进去。
- 若切换了 Cloud 实例、测试数据被覆盖或造数时间衰减，同步 §3 / §7 的基线数字（写成「实例 + 时间」双维度，别写死单一数字）。
- 若新增文件，同步更新 `README.md` 与 §6 文件地图。
- 跑一次 `npm test` 和 `npm run dry-run`，把数字写进上述文件。

---

## 10. 常见坑

- **别把生产实例 dry-run 的「计划 0 条」当 bug**：那批数据没有带时间的任务，见 §4 第 5 条；测试实例因造数会有 4 条计划。
- **别去试 `/openapi.json` 拿 schema**：带 token 也是 401，见 §4 第 4 条。
- **别改 `BASE` 规则去迎合扩展**：一致性与扩展是两条独立轨道，`strict_mode` 要能一键回到零差异。
- **别把 `T00:00` 判成仅日期**：官方 `hasTimeComponent = /[T\s]\d{2}:\d{2}/`，`T00:00` 算带时间。
- **重复提醒次数**是 `min(8, floor(120/interval))`：60 分钟间隔只有 2 次，不是固定 8 次。
- **别把 Webhook URL 写进数据库**：渠道名用 `email` / `webhook:N`。
- **别起两个副本**：无 leader election，会重复发送。
- **dry-run 偶发「0 条任务 + timeout」**：M4 开发中出现过一次，复跑即恢复 595/15；属经 Cloudflare 代理的瞬时抖动，连续多次失败再查网络或 token。
- **别把 M4 首次运行的本地 schema 变更当污染**：只给 `sent_log` 补 `namespace` 列、新建 `audit_log` 表与索引，历史记录归入 `default` 且不重发；对云端始终只有 GET。
- **别把测试服务器的数据当稳定基线**：客户端同步会整体覆盖测试库（§4 第 11 条）；`[NotifyTest]` 消失就重跑 `npm run seed:test`，脚本从不发 DELETE。
- **别把测试触发点过期当 bug**：时间相对造数时刻生成，数小时后 4 个触发点全滑出 BASE-27 窗口，dry-run 会变成「到点 0 / 过期跳过 4」。
- **别直接 `docker compose up` 上生产**：当前 `.env` 指向测试服务器；也别用 `docker compose config` 做校验——
  v5.7.1 实测会把 `env_file` 展开成明文（含 token）打印出来。校验请改用 `docker compose config --quiet`（零输出）。
- **别把 VPS 上 SMTP 投递失败当代码 bug**：该 VPS 出站到 587 / 465 均 `ECONNREFUSED`（宿主机直连同样如此），
  属网络策略；目标 B 已在本机验证真实 SMTP 实发，目标 D 改用同网络本地 Webhook 完成投递，见 §4 第 14 条。
- **联调专用 `compose.override.yaml` 不是生产配置**：里面设了 `SMTP_ENABLED=false` 与本地 Webhook 地址，
  真实部署前必须移除或改写。远端 `/data/home/notify-test/app/.env`（含真实凭据）与联调残留
  **已于 v1.10 删除**，需要复现时重跑 `python scripts/deploy-test.py prepare` 即可重新生成。
- **错误信息别直接落库**：Bun 下 `Error.message` 可能为空、fetch/SMTP 异常常带含密钥的 Webhook URL；
  统一走 `src/errors.ts` 的 `describeError`，不要写回 `?? '未知错误'` 或直接用 `error.message`。
- **新增运行时日志一律走 `src/logger.ts`**：直接 `console.log` 会绕过级别过滤与 URL 脱敏；
  只有「命令输出」（dry-run 计划、投递结果、配置错误）才用 console。
  `/healthz?token=` 的查询串绝不能进日志。
- **别把入站 GET 和出站 POST 搞混**：`docs/cloud-api.md` 讲对 Cloud 的只读 GET，
  `docs/webhook-payload.md` 讲发给接收方的 POST；平台适配器（钉钉/企微/飞书）发的是
  **中文纯文本**，不是结构化 `NotifyMessage`，且**企业微信没有签名**。
- **compose 已生产化，但部署前要过检查清单**：`healthcheck` / `read_only: true` / `tmpfs` 已落地（v1.9），
  生产镜像不再含 `scripts/`；`compose.yaml` 头部与 `README.md` 列了部署前检查项，尤其是
  **把 `MINDWTR_BASE_URL` 切回生产地址**、移除联调 `compose.override.yaml`。
  `read_only: true` 下只有 `/app/data` 卷与 `/tmp` 可写，别把状态库路径改到别处。
- **别把 dry-run 的「0 条 + fetch failed」当服务端挂了或代码回归**：多半是本机代理问题
  （命令行 `HTTPS_PROXY` 指向 48020、系统代理其实是 7897，Node `fetch` 默认不读代理），
  用 §7 的代理前缀复跑即可恢复；服务端 `/health` 一直 200，详见 §4 第 13 条。
- **别让 SMTP 行读取器丢行**：EHLO 多行响应常在单个 data 事件里一次性到达，没有 `readLine()` 等待者时也必须缓存，否则真实发信会永久挂起（v1.7 已修）。
- **真实渠道联调别连真实云端**：`node tests/e2e-channels.mjs` 已把 token 覆盖成假值、只连本机 mock；不要为了「更真实」把它改成直连生产实例。
- **别只看 HTTP 2xx 就说「投递成功」**：企微 / 钉钉 / 飞书会回 `200 + errcode!=0`；
  v1.15 起 `postWebhook` 已做业务码校验，新增接收端 / 适配器时不要绕过它。
  排障先跑 `--test-webhook --log-level=debug` 看适配器名与 `errcode`，详见 `docs/webhook-payload.md` §10。
- **提交身份要区分**：助手提交用 `scripts/agent-git.sh`（作者 `Notify Agent`、**不签名**），
  所有者自己 `git commit` 仍是 `zlay0701` 并沿用 `commit.gpgsign=true`（签名 / Verified）；
  不要图省事用 `git -c` 把助手提交写成所有者身份。
  助手提交不签名的原因：签名需要 pinentry 输密码，非交互环境拿不到；同时「是否签名」正好是第二重区分标记。
- **所有改动都要提交到 GitHub 公有仓库 `zlay0701/mindwtr-notify`（main），且不许提交敏感信息**：
  提交前用 `.env` 真实值做子串比对，白名单 `git add`；`.gitignore` 已忽略
  `.env` / `data/` / `.workbuddy/` / 私钥 / SQLite，CI 的 `no-secrets` job 会二次防呆。
  连接器 App 无权建仓（403），本机 GCM 凭据对 API 401，仓库需用户网页手动创建后再推送。
- **Coolify 部署别直接拿 `compose.yaml`**：要用 `docs/coolify.md` + `compose.coolify.yaml`
  （`${VAR}` 白名单注入、不发布宿主端口、凭据只在面板）。Coolify 版没发布端口，
  宿主机 `curl 127.0.0.1:8788` 不通，探活得进容器；另外**必须关掉 PR 预览部署**，
  否则预览实例会连同一套渠道重复发提醒。
