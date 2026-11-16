# Notify · Mindwtr 提醒服务

[![CI](https://github.com/zlay0701/mindwtr-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/zlay0701/mindwtr-notify/actions/workflows/ci.yml)

旁路提醒服务：按 **Mindwtr 官方规则**算出提醒触发点，再转发到邮件 / Webhook。
不接管客户端提醒、不改写任务数据、对云端**只读**。

> 想在新对话窗口继续开发？先读 **[HANDOFF.md](HANDOFF.md)**，里面有可直接复制的开工提示词。

## 代码仓库与提交约定

- **仓库**：[zlay0701/mindwtr-notify](https://github.com/zlay0701/mindwtr-notify)（**公有**，main 分支）。
  **所有改动都提交到这里**，文档改完也要同步提交。CI 徽章见页首，2026-11-15 首次运行三个 job 全绿。
- **绝不提交敏感信息**：`.env`、任何 token / 密码 / 连接串（`SSH_URI`）、Webhook key、真实收件邮箱、
  `data/` 状态库、`.workbuddy/` 工作记忆、私钥与证书。`.gitignore` 已加固，
  CI 的 `no-secrets` job 会在每次 push 时复查。
- 提交前用白名单 `git add`，并用 `.env` 真实值做一次子串比对；
  模板 `.env.example` 不含任何真实值，可以提交。
- CI（`.github/workflows/ci.yml`）：`npm test`、`docker build` + 禁网镜像冒烟、
  两份编排的 `config --quiet` 校验、敏感文件防呆。全程零密钥、不接触真实云端。
- **提交身份区分**：AI 助手的提交使用 `Notify Agent <notify-agent@users.noreply.github.com>`，
  你自己的提交保持 `zlay0701 <18520556+zlay0701@users.noreply.github.com>`。
  仓库默认身份**仍是你的**，所以直接 `git commit` 就是你本人；助手通过
  `scripts/agent-git.sh commit -m "..."` 临时切换身份，不会改动 `.git/config`。
- **签名也作为区分标记**：助手提交会带 `-c commit.gpgsign=false`（**不签名**，非交互环境也拿不到
  pinentry 密码）；你自己的提交沿用仓库的 `commit.gpgsign=true`，是**签名 / Verified** 的。
  也就是说在 GitHub 上：你的提交 = `zlay0701` + Verified，助手的提交 = `Notify Agent` + unverified。

## 文档导航

| 文档 | 内容 |
|---|---|
| [部署指南](docs/deployment.md) | Docker Compose 部署、运维命令、升级 / 回滚 / 备份、故障排查、安全边界 |
| [Coolify 部署教程](docs/coolify.md) | **三步快速路径** + 六步详细部署、环境变量白名单、域名与鉴权、卷 / 副本 / 预览、常见坑 |
| [配置参考](docs/configuration.md) | 全部环境变量、启动校验、三态标记、Webhook 验签协议、典型配置样例 |
| [页面操作手册](docs/admin-guide.md) | `/admin` 管理页、鉴权、六块视图、手动重发、healthz 与 API 速查 |
| [Cloud API 调用清单](docs/cloud-api.md) | 运行时实际调用的接口、白名单允许但不用、运维脚本、主动禁止的写端点 |
| [Webhook 输出数据格式](docs/webhook-payload.md) | 14 种 event 的完整字段表与 JSON 样例、四种 body、验签与幂等、**业务响应 `errcode` 校验** |
| [HANDOFF.md](HANDOFF.md) | 新窗口交接包：已确认事实、硬约束、未完成清单 |
| [spec.md](spec.md) | 唯一权威规则来源 |
| [docs/probe-result.md](docs/probe-result.md) | M0 脱敏实测报告 |

## 一句话理解这个项目

Mindwtr 自带的提醒全在**每台设备的客户端本地**触发，自托管的 `mindwtr-cloud` 只同步数据、不推送。
Notify 补上这一环：定时轮询 Cloud API，按官方源码里的同一套规则算出「什么时候该提醒谁」，然后用邮件和 Webhook 发出去。

规格书用**三态标记**区分每条规则的来源，写代码时必须保留：

| 标记 | 含义 | 数量 |
|---|---|---|
| 【一致】 | 官方文档/源码已有，逐字复刻（`BASE-01…29`） | 29 |
| 【增强】 | 官方有同一机制，扩展实现/范围/可靠性，不新增触发点 | 8 |
| 【官方无】 | 官方文档与源码均不存在 | 11（其中 4 个默认关闭） |

完整索引见 `spec.md` §2 / §15 / §16。

## 快速开始

本机是 **Node v22.22.2**（未装 Bun）。Node 22 能原生剥离 TypeScript 类型，所以开发期**零依赖、无需编译**；
生产镜像仍按选型用 `oven/bun:1.3-alpine`。代码同时兼容 Node 20+ 与 Bun。

```bash
cp .env.example .env      # 填入 MINDWTR_TOKEN（完整 bearer token，非 capture-only）
npm test                  # 85 个单元测试（含官方黄金比对夹具、M4、12 个日志级别与 11 个业务响应用例）
npm run dry-run           # 只读跑一轮 strict 计划，不投递、不写库
node src/cli.ts --dry-run --strict --log-level=debug  # 打印完整诊断链路（不用改 .env）
npm run once              # 跑一轮并真实投递（渠道未启用则只记录）
npm start                 # 常驻运行 + GET /healthz
npm run probe             # 重跑字段探针，输出 docs/probe-result.md
npm run seed:test         # 仅测试服务器：造 / 幂等滚动 5 条带时间的任务（脚本会硬拒绝生产地址）
```

常驻模式（`npm start`）会同时提供两个本地端点（compose 只映射回环）：

- `http://127.0.0.1:8788/healthz` —— 运行指标（EXT-12）
- `http://127.0.0.1:8788/admin` —— **只读管理页**：已发记录、失败重试、渠道状态、下一批待触发提醒、审计日志

管理页默认只读；手动重发入口需 `NOTIFY_ADMIN_RETRY=true` 且配置 `NOTIFY_ADMIN_TOKEN`（或复用 `HEALTHZ_TOKEN`），
token 由浏览器临时输入并放在请求头，不进 URL、不进日志。

其他调试入口：

```bash
node src/cli.ts --test-email      # 无 SMTP 时把测试邮件落盘到 data/test-emails.txt
node src/cli.ts --test-webhook    # 配好 WEBHOOK_URLS 后验证签名连通
node src/cli.ts --dry-run --strict
node tests/e2e-channels.mjs       # 目标 B 四项验收：真实 SMTP 发信 + Webhook 验签 + 渠道级重试 + 重启去重
                                  # 只连本机 mock Cloud，不碰真实云端；会真实发出邮件
```

## 配置

所有配置走环境变量，模板在 `.env.example`（已按里程碑分组并标注三态标记），
逐项说明与典型样例见 **[配置参考](docs/configuration.md)**。要点：

- `MINDWTR_BASE_URL` / `MINDWTR_TOKEN` —— 云端地址与完整 bearer token。
- `NOTIFY_NAMESPACE` —— M4 多实例隔离：配置 / 状态库 / 去重键按命名空间分开，默认 `default` 与旧版本完全兼容；非默认会自动派生 `data/notify-<ns>.sqlite`。
- `NOTIFY_LOG_LEVEL` —— 日志级别，默认 `info`；排障设 `debug`（或临时 `--log-level=debug`），
  可选 `warn` / `error` / `silent`。命令输出（dry-run 计划、投递结果）不受级别影响；详见 **[配置参考 §9](docs/configuration.md)**。
  Webhook 实际发出的字段与四种 body 形态见 **[输出数据格式清单](docs/webhook-payload.md)**。
- `NOTIFY_ADMIN_TOKEN` / `NOTIFY_ADMIN_RETRY` —— 管理页鉴权与手动重发总开关；重发默认关闭且强制鉴权。
- `NOTIFY_TAG_RULES` / `NOTIFY_WEBHOOK_ADAPTERS` / `NOTIFY_ALLOW_WRITE` 等扩展**默认全部关闭**。
- `strict_mode: true` 会强制关掉全部「新增触发点」类扩展，用于一致性验收。
- A 类扩展（仅日期 09:00 提醒、backlog 汇总、静默时段）代码在，但默认不开。

## 目录结构

```
spec.md              规格说明书（唯一权威规则来源，v1.19）
HANDOFF.md           新对话窗口的交接包 / 开工提示词
README.md            本文件
.env.example         配置模板（不含真实凭据）
Dockerfile           Bun 1.3 镜像（只 COPY package.json + src/，不含开发脚本）
compose.yaml         replicas: 1、healthcheck、read_only: true + tmpfs、healthz 只映射回环、
                    头部附生产部署前检查清单
compose.coolify.yaml  Coolify 专用编排（${VAR} 白名单注入凭据、不发布宿主端口）
.dockerignore        构建上下文排除规则（排除 .env / scripts/ / tests/ / data/ 等）
package.json         npm 脚本（零运行时依赖）
scripts/probe.mjs    只读字段探针（Node 18+，全中文注释、脱敏报告）
scripts/seed-test-data.mjs  测试实例造数（非生产地址硬检查、按标题幂等；产品代码仍只读）
scripts/remote.py    远程 Linux 运维助手（check/sync/test/build/smoke；none 认证、凭据脱敏、
                    上传白名单排除 .env，不启动容器、不发邮件；不进生产镜像）
scripts/deploy-test.py  目标D部署联调执行器（prepare/up/verify/down/status；隔离项目名与卷、
                    凭据内存 SFTP 上传、过滤 SSH_URI、compose 校验只用 config --quiet）
docs/deployment.md    Docker Compose 部署与运维指南
docs/coolify.md       Coolify 面板部署教程（含专用编排说明）
.github/workflows/ci.yml GitHub Actions：单测、镜像构建、编排校验、敏感文件防呆
docs/configuration.md 全量配置参考、验签协议、典型样例
docs/admin-guide.md   /admin 管理页操作手册（鉴权、重发、API 速查）
docs/cloud-api.md     Mindwtr Cloud API 调用清单（运行时 / 脚本 / 禁止）
docs/webhook-payload.md Webhook 出站数据格式清单（字段表、样例、验签、隐私边界）
docs/probe-result.md  M0 实测报告
src/
  config.ts          环境变量加载与校验（含按 namespace 分段配置）
  errors.ts          v1.10：错误信息归一化（非空兜底、URL 脱敏、截断），供各模块共用
  logger.ts          v1.13：EXT-20 分级日志（五级、时区时间戳、URL 脱敏、结构化字段）
  types.ts           任务/项目/触发点类型
  cloud/client.ts    只读 Cloud 客户端：GET 双白名单、total 翻页、rev 合并、退避、项目缓存
  rules/
    reminder-plan.ts 【一致】BASE 规则引擎（纯函数，逐条标注编号）
    time.ts          Intl 时区换算
    plan.ts          统一计划：任务级 + 三类摘要 + A 类扩展
    tag-policy.ts    【官方无】标签路由（M3）
  state/
    namespace.ts     M4 命名空间规范化、去重键前缀、状态库路径派生
    store.ts         SQLite WAL、sent_log、渠道级去重、命名空间隔离、审计与重试
  admin.ts           M4 只读管理页（HTML + JSON API + 鉴权 + 审计）
  dispatch/
    message.ts       消息渲染与隐私裁剪
    email.ts         最小 SMTP（465 / 587+STARTTLS+AUTH）
    webhook.ts       HMAC 签名、5 分钟防重放、指数退避重试
    adapters.ts      【官方无】钉钉 / 企微 / 飞书适配器（M3）
    index.ts         渠道级分发器
  actions/complete.ts 【官方无】双向完成只读闸门（M3，默认永不发写请求）
  scheduler.ts       轮询、5 分钟补发、失败告警与恢复
  healthz.ts         GET /healthz + /admin 路由委托、共享恒定时间鉴权
  cli.ts             全部命令行入口
tests/               8 个测试文件，共 85 个用例
  reminder-plan.test.ts   M1 规则引擎（BASE-21/22/12/25/23/16/17/18/19/28 + 易错回归）
  m2-rules.test.ts        M2 三类摘要 / A 类扩展 / 时区
  m2-delivery.test.ts     M2 渠道：SMTP、Webhook 签名与重试、状态库去重
  m3.test.ts             M3 标签路由、平台适配器、双向完成只读闸门
  official-golden.test.ts 目标 A：官方 schedule-utils.ts 黄金基准比对（strict 差集为空）
  official-schedule.ts   官方 schedule-utils.ts 逐字移植基准（date / due-reminder-lead /
                          task-status / task-reminder-policy 依赖），供 golden 夹具使用
  m4.test.ts             M4 命名空间隔离、只读管理页、鉴权重发、审计、strict 一致性
  logging.test.ts        v1.13：日志级别过滤 / 格式 / 脱敏 / 配置覆盖 / 调度与 Cloud 集成
  webhook-response.test.ts v1.15：业务码校验 / 假成功拦截 / 兼容与脱敏 / wecom 适配器链路
  e2e-channels.mjs       目标B真实渠道联调（本地 mock Cloud + 真实 SMTP + 独立验签接收端；不进 npm test）
```

## 三条硬约束（改动代码前必读）

1. **只读**：对 Cloud API【生产实例】只允许 `GET`，且路径必须在白名单内；禁止 POST / PUT / PATCH / DELETE。
   `src/actions/complete.ts` 是唯一涉及写端点的代码，需两道开关同时打开且无任何自动调用路径——**默认永不触发**。
   已授权例外：测试服务器上可用 `npm run seed:test` 造数（脚本硬拒绝生产地址），产品代码 `src/` 仍严格只读。
2. **凭据**：token 只放本机 `.env`，不写日志、报告、聊天输出或任何云端资源。`.gitignore` 已排除 `.env`。
3. **代码风格**：人类可读优先，命名直白、函数短小、必要中文注释；每个规则函数标注对应 `BASE-xx` / `EXT-xx` 编号与三态标记。

## 生产部署前检查清单

完整部署步骤见 **[部署指南](docs/deployment.md)**。这些是**部署动作**，不是开发任务；
开发期 `.env` 仍指向测试实例，不要提前改它。

1. 把 `.env` 的 `MINDWTR_BASE_URL` 切回生产地址 `https://mindwtr-cloud.zlay.dpdns.org`（`.env.example` 已是该值）。
2. 移除联调专用的 `compose.override.yaml`：它关掉了 SMTP、把 Webhook 指向本地接收端。
   （远端联调残留已于 v1.10 清理；需要复现用 `python scripts/deploy-test.py prepare` 重新生成。）
3. 校验用 `docker compose config --quiet`；**不要**用会展开 `env_file` 明文的 `docker compose config`。
4. 确认 `replicas: 1`、只起一个实例（无 leader election，多实例会重复投递）。
5. 确认 `read_only: true` 下状态库仍在卷 `/app/data`；不要改到只读根文件系统的其它路径。
6. 若该 VPS 出站 SMTP 587 / 465 仍被拒，邮件渠道无法投递（目标 D 已实测），需放行端口或改用中继。

## 当前状态

`npm test` **85/85 通过**（v1.15 起新增 11 个 Webhook 业务响应用例；含官方 `getTaskReminderPlan` 黄金比对夹具与 M4 的 11 个用例，strict 差集为空，纯本地、不受所连实例影响）。

⚠️ **当前 `.env` 指向测试服务器**（2026-11-14 起）。`npm run dry-run` 的数字取决于**所连实例 + 造数距今多久**：

- 测试服务器（本次整理实测）：**14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**；
  刚跑完 `npm run seed:test` 的几分钟内是「到点 1 条」；测试库还可能被客户端同步整体覆盖。
- 生产实例历史基线：**595 条任务 / 15 个项目、计划 0 条**（数据全无时间字段），切回生产地址即恢复。

M0–M4 代码均已完成；带时间任务的端到端验证已在测试实例跑通（渠道用本地假响应，见 `spec.md` v1.5）；
**真实渠道端到端联调（目标 B）已于 2026-11-15 通过**（v1.7）：真实 SMTP 实发、Webhook 独立验签、
渠道级独立重试、跨进程重启不重复投递，执行器为 `tests/e2e-channels.mjs`。

**VPS 部署联调（目标 D）已于 2026-11-15 通过**（v1.8）：独立项目名 / 卷 / 端口下起单副本服务，
healthz 与管理页 200、挂卷持久化、真实投递一轮、重启后零投递；执行器为 `scripts/deploy-test.py`。
⚠️ 该 VPS 出站到 SMTP 587 / 465 被拒，联调阶段改用同网络本地 Webhook 完成投递，
SMTP 凭据仍完整注入容器，未来放行端口即可启用。

**目标 E「compose / Dockerfile 生产化补齐」已于 2026-11-15 完成（v1.9）**：`healthcheck`、
`read_only: true` + `tmpfs` 落地，生产镜像剔除 `scripts/`，新增 `.dockerignore`，并在远端用真实 Docker 验证
（`config --quiet` 通过、镜像不含造数脚本与 `.env`、容器 `HEALTH=healthy` 且 `READONLY=true`、卷与 `/tmp` 可写），
见 `spec.md` §12.3。五个目标 A–E 全部完成；剩余仅 `complete` 写端点实测（只读约束主动不做）与内网直连（可选）。

**v1.10 缺陷修复（2026-11-15）**：新增 `src/errors.ts` 统一错误信息归一化，修掉 Bun 下空 `error.message`
写空串、以及异常文本里含密钥的 Webhook URL 落库两类问题；healthcheck 的 `HEALTHZ_TOKEN` 鉴权分支
完成端到端验证（不带 token 401 / 带 token 200 / 仍 healthy）；远端含凭据的联调残留已清理。
`npm test` 本地与远端均 62/62，详见 `spec.md` §12.4。

**v1.13 可配置日志级别（2026-11-15，EXT-20【官方无】）**：新增 `src/logger.ts`，
`NOTIFY_LOG_LEVEL=debug|info|warn|error|silent` 控制运行时诊断日志（默认 `info`），
也可用 `--log-level=debug` 临时覆盖；`debug` 会打印每个 Cloud GET 的路径 / 状态 / 耗时、计划条数、
逐条触发点决策与渠道投递结果，全部经 URL 脱敏、不含凭据与任务正文。
命令输出始终可见；`tests/logging.test.ts` 新增 12 个用例，`npm test` 现为 **74/74**（本地与远端均通过），
远端 `docker build` 与禁网 Bun 镜像冒烟通过。详见 `spec.md` §12.5 与 **[配置参考 §9](docs/configuration.md)**。

**v1.15 Webhook 业务响应校验（2026-11-15）**：`src/dispatch/webhook.ts` 在 HTTP 判定之后
再校验业务码，识别企微 / 钉钉 `errcode` 与飞书 `StatusCode` / `code`，
解决「HTTP 200 但 `errcode!=0` 被误报成功、群里没消息」；空 body、纯文本、自建接收端的
普通 JSON 不误伤。业务失败立即记 `failed`、不即时重试，由下一轮调度重投兜底。
同时修复 `--test-webhook`：此前固定走 `generic` 不看 `NOTIFY_WEBHOOK_ADAPTERS`，
现在按真实适配器投递并显示适配器名。新增 11 个用例，`npm test` 本地与远端均 **85/85**，
真实企业微信实测成功。详见 **[输出格式清单 §10](docs/webhook-payload.md)** 与 `spec.md` §12.6。

**v1.16 Coolify 部署教程（2026-11-15）**：新增 **[docs/coolify.md](docs/coolify.md)** 与
`compose.coolify.yaml`。因为 Notify 是**纯出站服务**，Coolify 上默认不配域名、不发布端口、
只跑单副本并关掉 PR 预览；凭据只在 Coolify 面板的 Environment Variables 里，
编排用 `${VAR}` 白名单注入（`MINDWTR_TOKEN` 必填），**故意不暴露云端写开关**。
已在 Coolify 4.7.5 / Traefik 3.7 环境只读核对，并用真实 Docker Compose 验证编排语法与必填约束；
**本次未实际创建资源或部署**。`npm test` 仍 85/85，详见 `spec.md` §12.7。

**v1.17 GitHub 公有仓库与 CI（2026-11-15）**：完成全量敏感信息审计（以 `.env` 真实值逐文件比对，
候选 54 个文件无任何凭据）、`.gitignore` 加固、白名单提交 52 个文件，新增
`.github/workflows/ci.yml`（单测 / 镜像构建 / 编排校验 / no-secrets 防呆），
并把「所有改动提交到 `zlay0701/mindwtr-notify`、不许提交敏感信息」写入长期约定。
仓库已上线（首次上线 commit `63c382c`，后续文档提交 `587e823`；当前 main 以页首徽章为准）。
每次推送都会触发 GitHub Actions `CI`，**已连续 3 次全部通过**（三个 job 全绿，实时状态见页首徽章）；
远端真实 `git clone` 后跑通 `npm test` 85/85、`docker build`、隔离 compose 部署
（`healthz`/`admin` 200、`HEALTH=healthy`、`READONLY=true`），验证后已清理。详见 `spec.md` §12.9。

⚠️ 本机命令行若出现「0 条任务 + `错误：fetch failed`」：是**代理配置**问题，不是服务端故障
（命令行 `HTTPS_PROXY` 指向 `127.0.0.1:48020`，系统代理其实是 `127.0.0.1:7897`，
Node `fetch` 默认不读代理变量）。两个 Cloud 实例的 `/health` 都返回 200。
按 `HANDOFF.md` §7 指定正确代理后 `dry-run` 恢复 14 条 / 1 项目 / 计划 4 条。
