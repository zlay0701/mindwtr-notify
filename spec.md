# Notify · Mindwtr 提醒服务 规格说明书

> 项目名：**Notify** · 包名/仓库/容器：`mindwtr-notify` · CLI：`mwnotify` · 中文：Mindwtr 提醒服务
> 命名含义：取「通知」本义；工程标识保留 `mindwtr-` 前缀（与官方 `mindwtr-mcp` 风格一致），避免与通用词 `notify` 混淆。定位：不接管客户端提醒、不改写任务数据，只把按官方规则算出的触发点转发到邮件 / Webhook。
>
> 版本：v1.18 · 日期：2026-11-15
> **v1.18 变更**：**代码已推送到 GitHub 公有仓库，CI 全绿，远端从 GitHub clone 部署验证通过**（纯文档，产品代码 `src/` 一行未动）。
> ① 仓库 `https://github.com/zlay0701/mindwtr-notify` 已上线（首次 `63c382c`、文档提交 `587e823`，54 个受版本控制的文件），
> 本地与远端同步，推送前按白名单与 `.env` 真实值做了二次扫描，**零凭据**。
> ② GitHub Actions `CI` 首次运行 **completed / success**：三个 job 全绿——
> 「单元测试（Node 22）」7 步、「镜像与编排校验」9 步、「敏感信息防呆」6 步，失败步骤 0；徽章 passing。
> ③ 远端从 `github.com` **真实 clone**（commit `63c382c`、`git ls-files` 54 个）后验证通过：
> 无 `.env` / `data/` / `.workbuddy/`；`npm test` **85/85**；两份编排 `config --quiet` 退出 0；
> `docker build` 成功；隔离 compose 部署 `healthz` / `admin` 均 **200**、`HEALTH=healthy`、
> `READONLY=true`、卷挂载正确；随后 `down` 并清理目录 / 卷 / 网络，**无残留**。
> 部署用假 token、不可达的本地 Cloud 地址、渠道全关：**未连真实云端、未发任何消息**。
> ④ 提交身份与签名分层：助手提交 = `Notify Agent` + **不签名**；所有者提交 = `zlay0701` + 签名（Verified）。
> `npm test` 仍 **85/85**，`dry-run` 只读，`.env` 未改动。详见 §12.9。
> **v1.17 变更**：**接入 GitHub 公有仓库与 CI，落地「敏感信息零提交」约定**（纯文档 + 一个工作流文件，产品代码 `src/` 一行未动）。
> ① 目标仓库 `https://github.com/zlay0701/mindwtr-notify`（public，main 分支）；用户明确要求
> **以后所有改动都提交到这里，且绝不提交敏感信息**，已写入用户级与项目级长期记忆。
> ② 提交前做了全量敏感审计：以 `.env` 里 11 个真实值为关键词逐文件比对，
> 排除 `.env` / `data/` / `.workbuddy/` 后的 54 个文件**不含任何真实凭据**；
> 命中的仅是公开 Cloud 域名与公共 SMTP 主机名（部署文档必要信息），两处假密钥已验证不等于真实值。
> `.gitignore` 加固：新增忽略 `.workbuddy/`、联调产物、`__pycache__/`、私钥 / 证书 / SQLite；
> 本地 `git init -b main` 后用白名单 `git add`，首次提交 52 个文件。
> ③ 新增 `.github/workflows/ci.yml`：`npm test`（Node 22）、`docker build` + 禁网镜像冒烟、
> `compose.coolify.yaml` / `compose.yaml` 的 `config --quiet` 语法校验、
> **no-secrets 防呆 job**（禁止 `.env` / 状态库 / 工作记忆 / 密钥文件、禁止带值凭据键）。全程零密钥。
> ④ 文档整理：README 新增「代码仓库与提交约定」，部署指南新增「从 GitHub clone 部署」，
> Coolify 教程写明具体仓库地址，六份 docs 头部版本统一到 v1.17。
> ⚠️ **当前阻塞**：GitHub 连接器的 App 无权创建仓库（403 `Resource not accessible by integration`），
> 本机已存 GitHub 凭据对 API 返回 401；仓库需用户在网页手动创建空仓库后才能推送与触发 CI。
> 仓库创建前用 `git archive HEAD` 导出白名单内容做等价的远端构建 / 编排验证（见 §12.8）。
> `npm test` 仍 **85/85**；`dry-run` 全程只读，`.env` 未改动。
> **v1.16 变更**：**新增 Coolify 部署教程**（纯文档 + 一份编排文件，产品代码 `src/` 一行未动）。
> 新增 `docs/coolify.md`：按「纯出站服务的三个默认选择 → 前置条件（Git 仓库 / .env 绝不提交）
> → 六步部署 → 可直接粘贴的环境变量清单 → 域名与鉴权 → 卷 / 副本 / 预览部署 → 部署后验证
> → 升级回滚备份 → 常见坑 → 安全边界 → 与原生 Compose 差异速查」组织。
> 新增 `compose.coolify.yaml`：把 `env_file: - .env` 换成 `${VAR}` 显式白名单（凭据只在 Coolify
> 面板）、去掉 `container_name` 与 `ports`，保留 `read_only` / `tmpfs` / 卷 / `healthcheck` /
> `replicas: 1`；**故意不注入** `NOTIFY_ALLOW_WRITE` / `NOTIFY_COMPLETE_ACTION`（只读硬约束）。
> 已在 **Coolify 4.7.5 / Traefik v3.7** 环境做只读核对（版本、网络、8788 空闲），
> 并在远端用真实 Docker Compose 验证编排：缺 `MINDWTR_TOKEN` 时 `${VAR:?}` 阻止部署（退出 1），
> 注入假值后 `config --quiet` 退出 0，关键结构全部保留。**未实际创建 Coolify 资源或部署。**
> `npm test` 仍 **85/85**；`dry-run` 全程只读、`.env` 未改动。详见 §12.7。
> **v1.15 变更**：**Webhook 业务响应校验 + 修复 `--test-webhook` 假成功**（改产品代码，BASE / strict 基线零改动）。
> ① `src/dispatch/webhook.ts` 在 HTTP 判定之后新增一层业务码判定：识别企业微信 / 钉钉的
> `errcode`、飞书的 `StatusCode` / `code`（后两者需同时带消息字段），解决「HTTP 200 但
> `errcode!=0`」被误报成功、群里没消息也不留失败记录的问题；空 body、纯文本、非 JSON、
> `generic` 自建接收端的普通 JSON 仍按原 2xx 语义，**不误伤**。业务错误只取 `errmsg` / `msg`
> 并统一 URL 脱敏与截断，不把整个响应体写进状态库。
> ② 业务失败是确定性错误（无效 key / 非法消息格式），**不即时重试**、避免刷群；
> 状态库记 `failed`，由下一轮调度跨轮重投兜底。非 2xx 仍按 `WEBHOOK_MAX_ATTEMPTS` 退避重试，
> 错误文本会同时含 HTTP 状态与业务码。
> ③ 修复 `src/cli.ts` 的 `--test-webhook`：此前固定走 `generic` 通用通道，不看
> `NOTIFY_WEBHOOK_ADAPTERS`，配了企业微信却用结构化 JSON 去测，是另一类「假成功」的根因；
> 现在按第一个 URL 的适配器走与常驻投递相同的路径，并在结果里打印适配器名。
> ④ 新增 `tests/webhook-response.test.ts` 11 个用例，`npm test` **85/85**（本地与远端均通过），
> 远端 `docker build` 与禁网 Bun 镜像冒烟通过；真实企业微信 `--test-webhook` 实测
> 「适配器 wecom，第 1 次尝试成功」。文档：`docs/webhook-payload.md` 新增 §10、
> `docs/configuration.md` 新增 §4.7.1「三层重试」、`docs/deployment.md` 故障表，其余头部版本同步。
> 下文各历史版本段落里的 `62/62` / `74/74` 是当时基线，属历史事实，未改写。详见 §12.6。
> **v1.14 变更**：**补齐 Webhook 输出数据格式清单**（纯文档，不改代码与规则）。
> 新增 `docs/webhook-payload.md`：按「传输层 / 完整字段表 / 14 种 `event` / JSON 样例 /
> 通用通道验签头 / 钉钉·企微·飞书三种 body / 数据最小化 / 对接自检」统计全部**出站 POST** 格式。
> 明确四种出站形态：`generic` 发结构化 `NotifyMessage`，钉钉发 markdown、企微与飞书发 text，
> 后三者是中文纯文本而非结构化 JSON；**企业微信无签名**，钉钉签名在 URL（毫秒 + base64）、
> 飞书签名在 body（秒 + base64），两者「密钥与被签数据的位置正好相反」。
> 所有样例由本地假数据实跑生成，未联网、未发真实 Webhook。
> 同时修正 `docs/configuration.md` §5 的不准确表述，并如实标注
> `privacy.stripFields` / `NOTIFY_DIGEST_WITHOUT_DESCRIPTION` 目前只是配置声明、渲染层未读取，
> 数据最小化实际由 `TaskSummary` / `renderMessage` 的类型白名单硬编码保证。
> `docs/{configuration,deployment,admin-guide,cloud-api}.md` 头部版本统一到 v1.14，
> `README.md` 导航与目录结构、`HANDOFF.md` §3/§6/§10 同步。`npm test` 仍 **74/74**。
> **v1.13 变更**：**可配置日志级别（EXT-20【官方无】）**。
> 新增 `src/logger.ts`（`debug/info/warn/error/silent` 五级、按 `NOTIFY_TIMEZONE` 渲染的时间戳、
> `[级别] [notify]` 前缀、结构化字段、统一 URL 脱敏）；`src/errors.ts` 导出 `redactUrls`，
> 让日志与状态库共用同一处脱敏规则。`src/config.ts` 读 `NOTIFY_LOG_LEVEL`（默认 `info`、
> 非法值回退并告警），`src/cli.ts` 支持 `--log-level=<级别>` 临时覆盖（非法值直接报错退出）。
> `scheduler.ts` / `cloud/client.ts` / `healthz.ts` 接入分级：debug 能看到每个 Cloud GET 的
> 路径 / 状态 / 耗时、项目缓存命中、计划条数、逐条触发点的窗口决策与渠道投递结果；
> 日志不含 token、Webhook URL、任务正文，`/healthz?token=` 的查询串也不进日志。
> **命令输出通道独立**：`--dry-run` / `--once` / `--test-*` / `--help` / 配置错误始终可见，
> 即使 `silent` 也不被吞；`info` 下 dry-run 输出与 v1.12 完全一致。
> 新增 `tests/logging.test.ts` 12 个用例，`npm test` **74/74**（本地与远端均通过），
> 远端 `docker build` 与禁网 Bun 镜像冒烟通过。文档：`.env.example`、
> `docs/configuration.md` §9、`docs/deployment.md` §8/§10/§12、`README.md`、`HANDOFF.md` 同步。
> **BASE 规则与 strict 基线未改动。** 下文各历史版本段落里的 `62/62` 是当时基线，属历史事实，未改写。
> 详见 §12.5。
> **v1.12 变更**：**补齐 Cloud API 调用清单文档**（纯文档，不改代码与规则）。
> 新增 `docs/cloud-api.md`：按「服务运行时实际调用 / 白名单允许但未调用 / 开发期与运维脚本 / 主动禁止」
> 四层列出全部接口。核实结论：运行时**只发 `GET /v1/tasks`（按状态分页）与 `GET /v1/projects`（缓存 10 分钟）**；
> `GET /health` 与 `GET /v1/tasks/:id` 虽在白名单但无调用点（列表字段比详情更全，不做两段式补查）。
> 同时厘清产品客户端白名单（4 条）与 M0 探针白名单（6 条）的差异，记录请求量估算、认证与响应要点、
> 测试实例造数脚本的授权例外，以及按只读约束主动不做的写端点。
> `deployment.md` 新增 §1.1 接口摘要，`configuration.md` / `admin-guide.md` / `README.md` 文档导航同步；
> 三份运维文档头部版本号统一到 v1.12（上次升版漏同步）。`npm test` 仍 **62/62**。
> **v1.11 变更**：**运维文档交付**（纯文档，不改代码与规则）。新增三份中文文档：
> `docs/deployment.md`（Docker Compose 部署 / 运维命令 / 升级回滚备份 / 故障排查 / 安全边界）、
> `docs/configuration.md`（配置优先级与全量配置项 / 启动校验 / 三态标记 / Webhook 验签协议 / 典型样例）、
> `docs/admin-guide.md`（`/admin` 管理页 / 鉴权 / 六块视图 / 手动重发 / healthz 与 API 速查）；
> 同步 `README.md` 文档导航、`HANDOFF.md` §6 文件地图，并补齐 `.env.example` 缺失的
> `NOTIFY_DIGEST_WITHOUT_DESCRIPTION`（代码会读、模板此前未列）。`npm test` 仍 **62/62**。
> **v1.10 变更**：**缺陷修复与收尾清理**（改产品代码，但 BASE 规则与 strict 基线零改动）。
> ① **错误信息归一化**：新增 `src/errors.ts` 的 `describeError`（`||` 非空兜底 + 去 http(s) URL + 截断 160 字），
> 统一替换 `src/dispatch/{index,webhook}.ts`、`src/scheduler.ts`、`src/cli.ts` 里的 `?? '未知错误'` 与原始 `error.message`；
> 修复 Bun 下 socket 错误 `message` 为空导致 `sent_log.last_error` 写空串，并阻止异常文本里含密钥的 Webhook URL 落库。
> `src/cloud/client.ts` 的 `summarizeError` 改为委托该函数（导出签名不变）。回归断言加进现有用例，`npm test` 仍 **62/62**。
> ② **healthcheck 鉴权分支端到端验证**：服务端临时开启 `HEALTHZ_TOKEN` 后，不带 token 的 `/healthz` **401**、
> 带 token **200**，而 healthcheck 仍 `HEALTH=healthy`（两次检查退出码 0）、`READONLY=true`。
> ③ **清理远端联调残留**：删除含真实凭据的 `.env`、联调 override、临时鉴权层与接收端；容器与网络已移除、测试卷保留。
> ④ 修正 §10 遗留①「重跑探针验证 `hasTimeComponent`」的过时表述（v1.5 已用测试实例造数覆盖）。
> 远端 `npm test` 62/62、`docker build` 成功、禁网镜像内新模块链路验证通过；
> `dry-run` 收尾为 14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条，全程只读。详见 §12.4。
> **v1.9 变更**：**目标 E「compose / Dockerfile 生产化补齐」完成**（纯配置改动，产品代码 `src/` 一行未动）。
> `compose.yaml` 补 `healthcheck`（用镜像自带 Bun 请求 `/healthz`，兼容 `HEALTHZ_TOKEN` 且刻意避开 `${}` 插值）、
> 落地 `read_only: true`（EXT-15【官方无】）+ `tmpfs /tmp`；`Dockerfile` 不再 `COPY scripts`，
> 新增根目录 `.dockerignore` 统一排除 `.env` / `scripts/` / `data/` 等；`scripts/remote.py` 同步该文件，
> `scripts/deploy-test.py` 改为读取它作为单一事实来源。远端真实 Docker 验证：
> `config --quiet` 通过；镜像 `/app` 只剩 `package.json / src / data`（无 scripts、无 .mjs/.py、无 .env）；
> 隔离容器 `HEALTH=healthy`（两次检查退出码 0）、`READONLY=true`、根文件系统不可写、
> `/app/data` 卷与 `/tmp` 可写、SQLite WAL 正常；验证后已 `down` 清理。详见 §12.3。
> 「部署前把 `MINDWTR_BASE_URL` 切回生产地址」固化为 `compose.yaml` 头部与 `README.md` 的部署前检查清单，
> **未擅自改 `.env`**：当前仍是测试实例，改动会立刻改变 dry-run 基线，且本轮不部署。
> `npm test` 仍 **62/62**；`dry-run` 收尾为 14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 3 条，全程只读。
> **BASE 规则与 strict 基线未改动。**
> **v1.8 变更**：**目标 D VPS 部署联调完成**。用户授权上传含 `MINDWTR_TOKEN` / `SMTP_PASS` 的 `.env` 后，
> 以独立项目名 `notify-test`、独立卷、`127.0.0.1:8789:8788`、单副本起 `docker compose up -d --build`；
> `/healthz` 与管理页均 200，卷挂载 `/app/data` 持久化，造数后真实投递一轮
> （同网络本地 Webhook 接收端独立验签通过），第二次重启后**零投递零请求**，跨重启去重生效。
> 新增 `scripts/deploy-test.py` 执行器；联调结束已停容器、保留测试卷。
> 实测该 VPS 出站到 SMTP 587 / 465 均 `ECONNREFUSED`（宿主机直连同样如此，属网络策略），
> 故联调阶段临时关闭 SMTP 投递并改用本地 Webhook；凭据仍完整注入容器，未来放行端口即可启用。
> `npm test` 仍 **62/62**；BASE 规则与 strict 基线未改动。
> **v1.7 变更**：**目标 B 真实渠道端到端联调完成** —— 真实 SMTP 实发、Webhook 独立 HMAC 验签（含错密钥 /
> 篡改正文对照）、渠道级独立重试、跨进程重启不重复投递，四项全部通过（见 §12 与 `tests/e2e-channels.mjs`）。
> 联调期间修复 `src/dispatch/email.ts` 的真实缺陷：SMTP 多行 EHLO 响应在单个 data 事件里到达时，
> 没有等待者的后续行会被丢弃，导致真实会话永久挂起；现改为缓存未读行。
> **BASE 规则与 strict 基线未动**，`npm test` 仍 **62/62**；联调脚本不进 `npm test` 用例集，故数量不变。
> 本机曾出现 `dry-run` 0 条 / `fetch failed`，根因是**本机代理配置**（命令行代理变量指向
> `127.0.0.1:48020`，而系统代理是 `127.0.0.1:7897`；Node `fetch` 默认不读代理变量），
> **服务端 `/health` 一直 200 `{"ok":true}`**。按 `HANDOFF.md` §7 指定正确代理后，
> `dry-run` 恢复 **14 条任务 / 1 个项目、计划 4 条、到点 0 条、过期跳过 4 条**；VPS 部署无需代理，产品代码未改。
> **v1.6 变更**：**交付物整理收尾（换窗口准备）** —— 只改文档、不动代码。把写死的 dry-run 基线改为
> 「所连实例 + 造数距今多久」的动态表述（本次实测：测试服务器 14 条任务 / 1 个项目、计划 4 条、到点 0 条、
> 过期跳过 4 条；生产实例 595 条任务 / 15 个项目、计划 0 条）；`HANDOFF.md` 重排未完成清单并新增纯本地目标 E
> （compose / Dockerfile 生产化补齐），补齐文件地图、当前环境提示与常见坑；修正 §5 中 `read_only: true`
> 「已落地」与 `compose.yaml` 不符的表述。`npm test` 仍 62/62、`npm run dry-run` 全程只读。
> **v1.5 变更**：**带时间任务的端到端验证完成**（用户把 `MINDWTR_BASE_URL` 切到测试实例并授权造数）。新增 `scripts/seed-test-data.mjs`（非生产地址硬检查、按标题幂等、只发 `POST /v1/tasks` 与 `PATCH /v1/tasks/:id`）；测试实例造了 5 条带 `dueDate` / `startTime` / `reviewAt` / 仅日期的任务，strict dry-run 从恒为 0 条变为 **计划 4 条、到点 1 条**，BASE-22 仅日期不触发在真实数据上得到验证；用本地假 Webhook 响应跑通「投递 → 渠道级成败 → 状态库去重 → 管理页四视图 → 受鉴权重发 → 审计」全链路（第 2 轮成功渠道重复跳过、失败渠道保留重试）。`npm test` 仍 **62/62**。**只读边界不变**：产品代码 `src/` 内严格只读，写操作全部发生在测试实例且由独立造数脚本执行，未触碰生产实例与 `/complete`。
> **v1.4 变更**：**M4 代码实现完成** —— 新增只读管理页（`src/admin.ts`：已发记录 / 失败重试 / 渠道状态 / 下一批待触发提醒 / 审计日志，`GET /admin` 与 `/healthz` 共用端口）、多命名空间隔离（`src/state/namespace.ts`：配置 `namespaces.<ns>` 分段、状态库按 namespace 分文件、去重键与 meta 键加前缀 + `sent_log.namespace` 列过滤）、受鉴权手动重发入口与审计日志（`src/state/store.ts` 新增列表 / 计数 / 重试 / 审计接口）。M4 属 `EXT-19`【官方无】后半，**不产生任何触发点**，strict 计划集合与基线 100% 一致；旧状态库首次运行自动补 `namespace` 列并把历史记录归入 `default`，不会重发历史提醒。测试增至 **62 个且全过**（M4 +11）；`npm run dry-run` 复验仍为 595 条任务 / 15 个项目、计划 0 条、全程只读。
> **v1.3 变更**：**M1 退出门槛补齐** —— 新增官方 `schedule-utils.ts` 黄金数据集合比对夹具：`tests/official-schedule.ts`（逐字移植官方 `getTaskReminderPlan` 及其依赖 date / due-reminder-lead / task-status / task-reminder-policy 作为基准）+ `tests/official-golden.test.ts`（28 条覆盖易错点的黄金数据、3 个用例），按 `(task_id, kind, scheduledAt)` 集合比对，**strict 模式差集为空**，M1 现标记验收通过。比对中纠正 2 处与官方不一致：`shouldSendReminderKind` 在单一 `start`/`due` 策略下 `review` 仍应触发、单一 `due` 策略下不排 `due-repeat`（`src/rules/reminder-plan.ts`）。测试增至 **51 个且全过**（M1 +5）；dry-run 基线不变（595 条任务 / 15 个项目，全程只读）。
> **v1.2 变更**：补齐交付物整理包 —— 新增 `HANDOFF.md`（新对话窗口交接包，含可直接复制的开工提示词、已确认实测事实、未完成清单与省积分工作法）、`README.md`（项目速览与文件地图）、`.gitignore`（排除 `.env` 凭据与运行期数据）。**代码与规则未改动**，46/46 测试与 dry-run 基线保持不变。
>
> **v1.1 变更**：**M3 代码实现完成**。新增标签路由（`src/rules/tag-policy.ts`）、钉钉/企业微信/飞书适配器（`src/dispatch/adapters.ts`）、双向完成只读闸门（`src/actions/complete.ts`）；测试增至 **46 个且全过**（M3 新增 12 个）；真实实例 `npm run dry-run` 复验仍为 595 条任务 / 15 个项目、全程只读。双向完成**默认永不发写请求**，且未做 `complete` 端点实测（受只读约束）。
>
> **v1.0 变更**：**M1 + M2 代码实现完成**。新增配置加载、只读 Cloud 客户端、SQLite 状态库、消息渲染、SMTP 邮件、HMAC 签名 Webhook、统一计划（三类摘要 + A 类扩展）、Scheduler、healthz、CLI、Dockerfile / compose；测试增至 **34 个且全过**；真实实例 `npm run dry-run` 拉取 595 条任务 / 15 个项目，全链路只读验证通过。A 类扩展仍默认关闭。
> **v0.9 变更**：M0 全量实测完成（token 已放入本地 `.env`，15 个只读 GET 全部成功，595 条活跃任务）；M1 规则引擎纯函数 + 14 个单元测试落地并全过；探针改为中文注释、按 `total` 翻页、全字段清单与日期格式统计；新增代码规范长期约定。
> **v0.8.1 变更**：M0 预检实测结果回写（`/health` 200、三处 `/v1` 401、`/openapi.json` 401 疑似受保护文档）；探针实现定为零依赖 `scripts/probe.mjs`（本机 Node v22、无 Bun），只读白名单与脱敏报告已落地；spec 与代码文件名对齐。
> **v0.8 变更**：文档改为**里程碑驱动**结构 —— §0 总览 + §10…14 五个可独立交付的里程碑（各含范围、任务、产出、验收、预算、退出门槛），公共规格与规则清单降为被引用资料。顺带修正 v0.7 的内部矛盾：三类摘要（BASE-08…10）明确归 **M2**，M1 只交付任务级与项目级规则。
> **v0.7.1**：项目定名 Notify（原工作名 Mindwtr Relay）。**v0.7**：引入三态标记 `【一致】` / `【增强】` / `【官方无】`。**v0.6**：拆成两份独立清单（BASE-01…29 / EXT-01…19）。
> 技术选型（已确认）：**Node.js + TypeScript（Bun）** · **SQLite** · **外部 SMTP** · **通用 Webhook + HMAC 签名** · **Docker Compose 同机编排**

**目录**：§0 里程碑总览 · §1–9 公共规格 · §10–14 里程碑计划 · §15–18 规则清单与验收矩阵

**配套文档**：新窗口继续开发请先读 [`HANDOFF.md`](HANDOFF.md)（交接包 + 开工提示词）；
项目速览与文件地图见 [`README.md`](README.md)；M0 实测原始数据见 [`docs/probe-result.md`](docs/probe-result.md)。
**本规格书是规则的唯一权威来源**；`HANDOFF.md` 只做索引与现状快照，若两者冲突以本文件为准。

---

## 0. 里程碑总览（文档主干）

### 0.1 路线与依赖

```
M0 实测探针 ──► M1 一致核心 ──► M2 摘要与扩展 ──┬──► M3 可选增强
                    │                  │          └──► M4 管理平台
                    └── strict 验收 ───┴── strict 验收（含扩展归因）
```

- **M0 → M1 → M2 为串行强依赖**，每个里程碑的「退出门槛」是进入下一个的硬条件。
- **M3 / M4 可选、可并行、可不做**；M2 交付即为一个功能完整的可用版本。
- 每个里程碑结束都要重跑一次 strict 计划比对，防止后续扩展污染基线。

### 0.2 总览表

| 里程碑 | 主题 | 状态 | 三态范围 | 退出门槛 | 轮次 / 积分估算 |
|---|---|---|---|---|---|
| **M0** | 实测探针与字段校准 | **已完成**（结论见 §10） | 预研，无业务规则 | 字段清单 + 连接信息确认 | 2–3 轮 / 20–40 分 |
| **M1** | 一致核心（任务级 + 项目级） | **已实现（含官方比对夹具，验收通过）** | 【一致】BASE-01…07、12…29；【增强】EXT-01(邮件)、06…10、14；【官方无】EXT-03、12、13、15 | **strict 计划比对差集为空** + 6 条易错回归全过 | 12–16 轮 / 400–700 分 |
| **M2** | 三类摘要 + Webhook + 增强开关 | **已实现（真实渠道联调 + VPS 部署联调 2026-11-15 均通过；生产化补齐 v1.9 完成）** | 【一致】BASE-08…10；【增强】EXT-01(Webhook)、02；【官方无】EXT-04、05、11、16…18 | 扩展归因零例外 + 全流程部署跑通 ✅ + 生产化配置验收 ✅ | 10–14 轮 / 400–750 分 |
| **M3** | 可选增强（标签 / 平台适配器 / 双向完成） | **已实现**（双向完成未实测写端点，见 §13） | 【官方无】EXT-19 前半 | 各适配器单测通过；双向完成需单独评审只读原则 | 8–12 轮 / 250–450 分 |
| **M4** | 管理平台与多命名空间 | **已实现（2026-11-13，验收通过）** | 【官方无】EXT-19 后半 | ✅ 只读管理页 + 命名空间隔离验证 | 8–12 轮 / 250–450 分 |

> 合计：**M0–M2（可用版）820–1,490 分**；**M0–M4（全量）1,320–2,390 分**。误差约 ±50%，口径见 §8。积分按月清零不结转，建议集中在一个月内完成（标准版 4,000 分/月足够）。

### 0.3 统一里程碑模板

每个里程碑按同一套字段描述：**目标 / 前置依赖 / 三态范围 / 任务清单 / 交付物 / 验收标准 / 预算 / 退出门槛 / 风险**。任务与验收用 `- [ ]` 勾选，完成后把状态从「未开始」改为「已完成」。

---

# Part I · 公共规格（所有里程碑共享）

## 1. 背景与定位

Mindwtr 的提醒完全在**客户端本地**调度（桌面/移动原生 App 用本地闹钟或 15s 轮询，Web/PWA 仅在标签页运行期间生效），自托管 `mindwtr-cloud` 服务端**不做任何推送**。本项目在 VPS 上部署常驻服务，轮询自托管 Cloud API，**镜像官方客户端的提醒判定逻辑**，把触发结果通过邮件与 Webhook 转发出去。

**三条铁律**：

1. **基线不可改写**：§15 清单 A 定义了「要不要发、什么时候发、发什么内容」，扩展只能叠加，不能覆盖、放宽或收紧任何一条 BASE 规则。
2. **新增触发点默认关闭**：会产生官方不存在的提醒、或改变官方发送时刻的扩展（EXT-16…19）一律 `enabled: false`。
3. **载体与工程扩展正交**：输出通道、持久化、重试、探活、调试入口只改变「发到哪里、怎么记录、怎么运维」，不改变触发判定结果。

> `strict_mode: true` 强制关闭全部 A 类扩展，用于一致性验收与排障。

**代码规范（长期约定，用户 2026-11-13 明确要求，之后不再逐次提醒）**：所有代码必须方便人类阅读——直白命名、平铺控制流、小函数、避免过度抽象；每个文件头说明职责，每个导出函数说明用途 / 参数 / 返回值，复杂算法与反直觉判断解释「为什么」；注释不过度、用简体中文，标识符与 API 字段保持英文原样。规则函数的注释里标注对应 `BASE-xx` / `EXT-xx` 编号与三态标记。

## 2. 命名与三态标记图例

| 标记 | 含义 | 判据 | 验收口径 |
|---|---|---|---|
| **【一致】** | 与官方完全一致 | 官方文档或源码**已有**该规则，逐字复刻 | strict 模式下与官方触发计划差集为空 |
| **【增强】** | 在官方已有机制上扩展 | 官方**有同一职责的机制**，扩展其实现、范围或可靠性；不新增触发点、不改变触发时刻 | 关闭后回落到对应 BASE 规则 |
| **【官方无】** | 官方完全没有 | 官方文档与源码**均不存在**该能力 | 需显式配置；A 类默认关闭 |

**两个正交维度**：归属维度＝三态标记；开关维度＝默认开 / 默认关。§16 中的 E 类（载体）/ S 类（工程）/ A 类（新增触发）只是组织分组，**不是**归属标记。

| 标记 | 条数 | 编号 | 默认状态 |
|---|---|---|---|
| 【一致】 | **29** | `BASE-01`…`BASE-29`（§15 全部；§17「不实现」归入 BASE-11，不重复计数） | 恒生效，不可关闭 |
| 【增强】 | **8** | `EXT-01, 02, 06, 07, 08, 09, 10, 14` | 默认开 |
| 【官方无】 | **11** | `EXT-03, 04, 05, 11, 12, 13, 15`（默认开）+ `EXT-16…19`（默认关） | 7 开 / 4 关 |

> 共 **48 条**：29 条照抄 + 8 条增强 + 11 条官方没有。编号是全文唯一引用键，里程碑只引用编号，不重复抄规则。

## 3. 架构与数据流

```
┌────────────┐   轮询 GET /v1/tasks    ┌──────────────────┐
│ Mindwtr    │ ◄─────────────────────  │  mindwtr-notify   │
│ Cloud API  │   (bearer token)        │  ┌────────────┐  │
│ + projects │                         │  │ Scheduler  │  │ 只按 BASE【一致】算触发点
└────────────┘                         │  └─────┬──────┘  │  + A 类【官方无】(默认关)
                                       │  ┌─────▼──────┐  │
                                       │  │ StateStore │  │ SQLite 去重 (EXT-06【增强】)
                                       │  └─────┬──────┘  │
                                       │  ┌─────▼──────┐  │
                                       │  │ Dispatcher │──┼──► SMTP 邮件 (EXT-01【增强】)
                                       │  │            │──┼──► Webhook(s)
                                       │  └────────────┘  │
                                       └──────────────────┘
                                            GET /healthz (EXT-12【官方无】)
```

- **Scheduler**：拉取 → BASE-28【一致】过滤 → BASE-16…20【一致】策略 → BASE-01…10【一致】触发点 → 与 StateStore 对账 → 到点投递；仅当 A 类【官方无】显式开启时追加 EXT-16/17/18 的结果。
- **StateStore**：`sent_log(task_id, trigger_type, trigger_at, channel, status, attempts, last_error, updated_at)`；`status` ∈ `pending/sent/failed/skipped_late`（EXT-06/07【增强】）。
- **去重键**：单任务 `task_id + kind + scheduledAt.toISOString() + channel`；重复 `${dueDate}#${index+1} + channel`；摘要 `kind + YYYY-MM-DD + channel`（BASE-29【一致】逻辑 + EXT-07【增强】channel 维度）。
- **重启恢复**：从 SQLite 恢复，不重发；短停机错过按 BASE-27【一致】的 5 分钟窗口补发，超时标 `skipped_late`。
- **项目缓存**：启动及每 10 分钟刷新 `GET /v1/projects`（EXT-10【增强】）。
- **代码分层约束**：触发点计算集中在单一模块（只实现 BASE 清单），扩展以插件式追加结果；禁止在 Dispatcher 或渠道代码里改写触发计划。每条规则在代码注释里标注编号与三态标记。

## 4. Cloud API 与拉取策略

**纯只读**（EXT-15【官方无】），不调用任何写端点。

| 端点 | 用途 |
|---|---|
| `GET /health` | 启动前探活 |
| `GET /v1/tasks` | 分状态拉取任务；`status` 一次只接受一个值 |
| `GET /v1/tasks/:id` | 两段式补查详情（列表字段不全时） |
| `GET /v1/projects` | 项目名 / 归档状态缓存 + `project.reviewAt`（BASE-07【一致】） |

认证：`Authorization: Bearer <token>`，需单独一个**完整** bearer token（capture-only 令牌在其他路由返回 403）。

**拉取**（EXT-09【增强】）：每轮对 `inbox`/`next`/`waiting`/`someday` 各一次请求，`limit`/`offset` 翻页，合并按 id 去重、按 `rev` 取新。**M0 实测**决定列表项是否含全套字段；缺字段则只对候选任务补查详情。

**归档项目过滤**（BASE-28【一致】）：优先用任务级 `projectArchivedAt`；字段缺失时回退项目缓存状态（EXT-10【增强】）；缓存不可用时保守放行。

> 可选交叉校验：`GET /v1/calendar/:token.ics` 内置「排除完成/归档/参考/删除/非活动项目」过滤，但事件只含 UID + 标题，主数据源仍用 `/v1/tasks`。

## 5. 配置草案（按里程碑渐进启用）

```yaml
# mindwtr-notify 配置
mindwtr:
  base_url: https://your-vps.example.com     # M0 确认
  token: ${MINDWTR_TOKEN}                    # M0 确认
timezone: Asia/Shanghai                      # M1
strict_mode: false                           # M1：true = 关闭全部 A 类【官方无】，用于验收
poll_interval_seconds: 60                    # M1 · EXT-08【增强】；设 15 与官方桌面端一致
grace_period: 5m                             # M1 · BASE-27【一致】
catch_up: true                               # M1

official_rules:                              # M1–M2 · 清单 A【一致】
  task_reminder_default: send                # BASE-17
  include_start: true                        # BASE-20
  include_due: true
  include_review: true
  include_reference: false                   # BASE-28
  digest:                                    # M2 · BASE-08…10
    morning:  { enabled: true, at: "09:00" }
    evening:  { enabled: true, at: "20:00" }
    weekly:   { enabled: true, day: 0, at: "18:00" }   # 0=周日

enhancements:
  triggers:                                  # M2 · A 类【官方无】，默认全关
    date_only:    { enabled: false, at: "09:00" }               # EXT-16
    backlog:      { enabled: false, min_interval: 24h }          # EXT-17
    quiet_hours:  { enabled: false, start: "23:00", end: "08:00", defer: true }  # EXT-18
  reliability:                               # M2 · EXT-11【官方无】
    poll_failure_alert_after: 3
    max_backoff: 10m

channels:                                    # M1 邮件 / M2 Webhook
  email:                                     # M1 · EXT-01【增强】
    enabled: true
    smtp: { host, port: 587, secure: false, require_tls: true, user, pass_env, from, from_name }
    to: [you@example.com]
  webhook:                                   # M2 · EXT-04/05【官方无】
    enabled: false
    urls: [https://hook.example.com/xxx]
    secret_env: WEBHOOK_SECRET
  privacy:                                   # M1 · EXT-03【官方无】
    strip_fields: [attachments, assignedTo, contexts, tags]
    digest_without_description: true
healthz_token: ${HEALTHZ_TOKEN}              # M1 · EXT-12【官方无】
```

> 任务级提前量、重复间隔、发送策略**不在此配置**（BASE-14【一致】），直接读取任务的 `dueReminderLeadMinutes` / `startReminderLeadMinutes` / `repeatReminderMinutes` / `reminderPolicy` 字段。
> 部署：容器 `mindwtr-notify`，`replicas: 1`（EXT-14【增强】）已在 `compose.yaml` 落地；
> `read_only: true`（EXT-15【官方无】）**已于 v1.9 落地**（配合 `tmpfs /tmp` 与状态库卷），
> `healthcheck`、生产镜像剔除造数脚本、`.dockerignore` 也一并完成（见 §12.3 / `HANDOFF.md` §4 第 15 条）。

## 6. 消息格式（EXT-02【增强】，M2 交付）

```json
{
  "event": "task.due",
  "task": { "id": "...", "title": "...", "status": "next",
            "dueDate": "...", "startTime": "...", "reviewAt": "...",
            "projectId": "...", "projectName": "...",
            "description": "..." },
  "trigger": { "type": "start|start_advance|due|due_advance|due_repeat|review|project_review|digest_morning|digest_evening|digest_weekly|date_only|backlog",
               "at": "2026-11-13T09:00:00+08:00", "leadMinutes": 30, "repeatIndex": 1 },
  "digest":  { "dueToday": [ ... ], "overdue": [ ... ], "startingToday": [ ... ] },
  "backlog": { "count": 3, "tasks": [ ... ] },
  "links":   { "app": "https://your-mindwtr.example.com/#/task/..." },
  "sentAt":  "..."
}
```

`event` 决定存在哪个块；单任务触发带去 Markdown 的 `description`（BASE-15【一致】），digest/backlog 汇总类不带（EXT-03【官方无】）；任何消息都不含 `attachments`/`assignedTo`/`contexts`/`tags`。`date_only`/`backlog` 两种 type 仅在对应【官方无】扩展开启时出现。

## 7. 全局实现约定（写代码前需遵守）

1. **仅日期判定**：严格复用官方正则 `/[T\s]\d{2}:\d{2}/`；`T00:00` 属**带时间**。strict 下 false 一律不排提醒（BASE-22【一致】），只有 EXT-16【官方无】开启才进入 09:00 增强。
2. **提前量算术**：`lead % 1440 === 0` → 日历日回退；否则按分钟回退。`startReminderLeadMinutes` 只接受 `0/5/15/30/60`，`repeatReminderMinutes` 只接受 `5/10/15/30/60`，非法值按「未设置」处理。
3. **重复次数**：`min(8, Math.floor(120 / interval))`，不是固定 8 次。
4. **策略优先级**：`reminderPolicy` > `suppressMindwtrReminders` 回退 > 默认 `send`；`inherit` 再取 `official_rules.task_reminder_default`。
5. **Webhook 签名**（M2）：`X-Notify-Timestamp`（Unix 秒）+ `X-Notify-Signature: sha256=<hex>`；签名串 `${timestamp}.${rawBody}`（原始 JSON 字节，不重新序列化），HMAC-SHA256 十六进制小写；接收方校验时间戳偏差 ≤5 分钟并恒定时间比较。
6. **分页保护**：返回 0 条、offset 超过 100 页、或出现重复 id 循环 → 终止该状态本轮拉取并记 warning。
7. **静默与解禁**（M2，仅 EXT-18 开启时）：被顺延的 overdue 升级不叠加补发，解禁后只发一条最新状态提醒。
8. **调试入口**：`mwnotify --dry-run`、`--strict`、`--test-email`、`--test-webhook`、`--once`、`probe`（M0）。
9. **分层约束**：见 §3 末段；代码注释标注编号与三态标记。

## 8. 风险与积分口径

- **积分口径**：WorkBuddy 积分 = 模型 token 单价 × 任务复杂度 × 上下文长度，官方无「每行代码固定分」表。§0 的估算基于 M0–M4 工作量拆解与公开案例锚点，误差约 ±50%；**校准方法**：M0 跑完后看「设置 → 订阅管理 → 积分明细」的实际扣除，再按轮次外推。
- **省积分**：按里程碑开新会话（长会话 2–4x）；M1 规则引擎直接移植官方源码而非重新推导；M0 探针结果一次给全；用 `--dry-run` 自测减少来回调试；写代码用中档模型，不开 Max / Auto 顶配。
- **令牌**：完整 bearer token，妥善保管，不进前端/日志。
- **限速**：文档未公布阈值，轮询默认 60s 且可配；分状态拉取每轮 4 次请求，间隔建议 ≥30s。
- **时区/DST**：UTC 存储、按 `timezone` 渲染；按天/周的提前量必须走日历日算术（BASE-23【一致】），不能简单减毫秒。
- **同步延迟**：任务修改后需客户端同步才对 API 可见；提醒以服务端看到的数据为准。
- **字段兼容**：`reminderPolicy`、`dueReminderLeadMinutes` 等为较新版本字段；旧版客户端（≤1.3.6）可能丢失 `inherit`，使用前请升级所有写入客户端、自托管服务器与自动化客户端。
- **取消语义**：`status=archived` + `cancelledAt` = 已取消（无 `completedAt`、不生成下一次重复）。
- **数据外发**：邮件与第三方 Webhook 会带出任务标题；描述仅单任务提醒携带。
- **Compose 服务名**：`mindwtr-cloud:8787` 取自官方示例，M0 对照你 VPS 的实际 `compose.yaml` 确认。

## 9. 技术选型（已确认）

| 组件 | 决策 |
|---|---|
| 语言/运行时 | Node.js + TypeScript，Bun 运行时（兼容 Node 20+）；与 Mindwtr 官方镜像同生态（Bun 1.3），类型可对齐 `packages/core/src/task-sync-schema.ts` |
| 状态存储 | SQLite（WAL，单文件挂卷持久化），`bun:sqlite` 内置 |
| 邮件 | 外部 SMTP 账号（需配好 SPF/DKIM），凭据走 env |
| Webhook | 通用 Webhook + HMAC-SHA256 签名起步；平台适配器列入 M3 |
| 部署 | Docker Compose 与 mindwtr-cloud 同机同网络，`replicas: 1` |

> 未采纳：Python/FastAPI、Go、Redis、Resend 类邮件 API、VPS 自建 Postfix。

---

# Part II · 里程碑计划（文档主干）

## 10. M0 · 实测探针与字段校准

**目标**：用最小代价消除「实现前必办」的两个未知数，决定 M1 的拉取实现方式。**状态：已完成（2026-11-13）· 无业务规则交付。**

**前置依赖**：VPS 地址（已给 `https://mindwtr-cloud.zlay.dpdns.org`）、完整 bearer token（已放本地 `.env`，值不记录）、compose 信息（仅 M1 部署阶段需要）。

**三态范围**：不实现任何 BASE 规则。仅涉及 EXT-09【增强】的前置验证、EXT-13【官方无】的调试入口、EXT-15【官方无】只读边界。

**只读承诺**：本里程碑及后续开发**只向云端发 `GET` 请求**，禁止 POST / PUT / PATCH / DELETE，不写入任何任务、项目或附件数据。探针在代码层用「方法白名单 + 路径白名单」双重约束；token 只从本地 `.env` / 环境变量读取，不进聊天记录以外的任何输出。

> **2026-11-14 的显式例外（仅限测试实例，不改变上述承诺）**：用户切换到测试服务器并授权造数后，
> `scripts/seed-test-data.mjs` 会向**测试实例**发 `POST /v1/tasks` 与 `PATCH /v1/tasks/:id`。
> 这是独立于产品代码的造数工具，不是 Notify 的运行时行为：`src/` 内（尤其 `src/cloud/client.ts`
> 的 GET 双白名单）一字未改，`src/actions/complete.ts` 仍默认永不触发，生产实例自始至终只收到过 GET。
> 脚本启动时会硬检查地址，一旦 `.env` 指回生产地址立即拒绝执行。
> 因此本规格各里程碑章节里「595 条任务 / 15 个项目、计划 0 条」的验收数字，均为**生产实例**基线，
> 仍是有效的历史结论；当前测试实例的数字见头部变更说明与 `HANDOFF.md` §3 / §7。

**实测结论（15 个只读 GET，除预期的无令牌 401 外全部 200）**

| 项 | 结果 |
|---|---|
| 连通性 | `GET /health` → 200 `{"ok":true}`，约 0.6–2.1s，经 Cloudflare 代理 |
| 鉴权 | 无令牌 `/v1/*` → 401；带令牌四状态列表、单任务详情、项目列表全部 200 |
| 分页 | 响应外壳 `{tasks, total, limit, offset}`；`next` 共 568 条分 6 页拉全，inbox 24、waiting 0、someday 3，**合计 595 条活跃任务** |
| 列表 vs 详情 | 详情**没有**独有字段，列表反而多 `description` / `projectId` / `recurrence` 等 → **不需要两段式补查**，M1 只拉列表 |
| ETag | 列表未返回；详情返回弱 ETag `W/"mindwtr-entity-sha256-…"`。本服务纯只读，用不上 If-Match |
| 项目 | 15 条，含 `status` / `title` / `rev` / `isFocused`；未见 `reviewAt` / `archivedAt` → 归档过滤回退项目 `status` |
| API 文档 | `/openapi.json`、`/swagger.json` 带令牌**仍 401**，拿不到 schema；字段结论以实测 + 官方源码为准 |
| ⚠️ 最大发现 | **595 条活跃任务中没有任何 `dueDate` / `startTime` / `reviewAt` 及提醒参数字段**。这些是条件性字段，当前数据下只有摘要类提醒会触发；规则引擎按官方 schema 声明为可选字段，并用单元测试覆盖 |

> 列表项出现的全部字段见 `docs/probe-result.md` §5（`reminderPolicy`、`suppressMindwtrReminders`、`pushCount`、`isFocusedToday`、`contexts`、`tags`、`recurrence` 等）。建议之后在客户端给一条任务设置明确截止时间，重跑本探针即可端到端验证 `hasTimeComponent` 的真实存储格式。

**任务清单**

- [x] 写只读探针 `scripts/probe.mjs`（Node 18+ 内置 fetch、零依赖、全中文注释）。本机 Node `v22.22.2`、未装 Bun，故 M0 用 `.mjs` 独立脚本；主服务仍按 §9 选型用 Bun/TS，M1 再收编为 `mwnotify probe`。
- [x] 无令牌预检模式 + 完整模式均可运行，自动产出脱敏报告。
- [x] 四状态按 `total` 翻页拉全（595 条）+ 单任务详情逐字段对比 + 项目列表 + OpenAPI 探测。
- [x] 输出全字段清单与「列表 vs 详情」差集，避免把条件性字段误判为缺失；输出时间字段格式分布。
- [x] 记录地址与 token 可用性。
- [x] 结论落档：**单段式拉取**（列表字段已足够）。
- [ ] 内网直连信息（compose 服务名/端口/网络名）→ **转移到 M1 部署阶段**。已拿到网络 `rifyenhfmtws99c3pea0zu4d`、容器 `mindwtr-cloud-rifyenhfmtws99c3pea0zu4d`、内外端口 8787，尚待内网连通性实测。

**交付物**：`scripts/probe.mjs`（中文注释、按 `total` 翻页、全字段与日期格式统计）、`.env.example`、`docs/probe-result.md`（完整版报告）。

**验收标准**

- [x] 探针只读，不调用任何写端点；token 不写进日志或输出文件；报告不输出任务标题、描述、附件、负责人、标签等正文内容。
- [x] 四状态翻页取全，无重复 id 循环（`next` 6 页验证通过）。
- [x] `docs/probe-result.md` 明确回答「是否走两段式」：**否**。
- [x] 地址与完整 bearer token 已确认可用。
- [ ] 内网直连连通性验证（M1 部署阶段，可选；不提供则沿用公网 HTTPS 地址）。

**预算**：实际约 3 轮。

**退出门槛**：✅ **已通过** —— 列表字段足够、分页行为确认、连接信息确认，M1 拉取模块的实现方式已确定。

**遗留**：① ~~客户端给一条任务设置明确截止时间后重跑探针~~ —— **已完成**：v1.5 在测试实例用
`npm run seed:test` 造 5 条带 `dueDate` / `startTime` / `reviewAt` / 仅日期的任务，`hasTimeComponent` 与
BASE-21/22 均已在真实数据上验证（见头部 v1.5 变更与 §12），不是待办。
② 内网直连连通性验证仍挂 `- [ ]`，属**可选**：按约定默认走公网 HTTPS，且容器随机名重建后会变
（§4 第 9 / 12 条已两次印证），不实测不影响功能；若要做，命令是
`docker run --rm --network rifyenhfmtws99c3pea0zu4d curlimages/curl -s http://mindwtr-cloud-rifyenhfmtws99c3pea0zu4d:8787/health`（纯 GET /health）。
③ 网络名/容器名带面板生成的随机 ID，重建应用后可能变化。

---

## 11. M1 · 一致核心（任务级 + 项目级规则）

**目标**：把 29 条基线里的任务级与项目级规则全部实现，并用官方算法验证「零差异」。**状态：已实现（含官方 `getTaskReminderPlan` 黄金数据集合比对夹具，strict 差集为空，M1 验收通过）。**

**前置依赖**：✅ M0 退出门槛已通过（列表字段足够、分页行为确认、连接可用）。

**三态范围**

| 标记 | 本里程碑交付 |
|---|---|
| 【一致】 | `BASE-01…07`（六类任务意图 + project-review）、`BASE-12…29`（字段、策略、时间数值、过滤去重、补发） |
| 【增强】 | `EXT-01`（邮件通道部分）、`EXT-06/07/08/09/10/14` |
| 【官方无】 | `EXT-03`（隐私裁剪）、`EXT-12`（healthz）、`EXT-13`（调试 CLI）、`EXT-15`（纯只读边界） |

> 三类摘要 `BASE-08…10` 归 **M2**，不在本里程碑（v0.7 中「M1 交付 BASE 全量」与「M2 才做三类摘要」的矛盾已在此修正）。

**任务清单**

- [x] 项目骨架：`package.json`（`npm test` / `npm start` / `npm run dry-run` / `npm run probe`）；Node 22 原生剥离 TS 类型，开发期零依赖、无需编译。
- [x] Cloud API 客户端（`src/cloud/client.ts`）：分状态拉取、`total` 翻页保护、按 `rev` 合并、失败退避、项目缓存 10 分钟；方法与路径双白名单。
- [x] **规则引擎**（`src/rules/reminder-plan.ts`）：`hasTimeComponent`、日历日算术、`min(8, floor(120/interval))`、`reminderPolicy` 五态 + 旧字段回退、`skip` 仍发 review、单一策略抑制、活跃/归档项目过滤、`getTaskReminderPlan`；纯函数，逐条标注 BASE 编号。
- [x] 5 分钟补发窗口 + `catch_up` 总开关（`src/scheduler.ts`，BASE-27）。
- [x] StateStore（`src/state/store.ts`）：SQLite WAL、`sent_log`、渠道级去重与审计；运行时适配 `bun:sqlite` / `node:sqlite`。
- [x] Dispatcher：消息渲染与隐私裁剪、SMTP（465 隐式 TLS / 587 STARTTLS / AUTH LOGIN）、HMAC 签名 Webhook、渠道级独立重试。
- [x] Scheduler：轮询循环、`strict_mode`、失败告警与恢复通知、优雅退出；`GET /healthz`（可选 token 鉴权）。
- [x] CLI：`--dry-run` / `--strict` / `--once` / `--test-email` / `--test-webhook`，常驻模式带 SIGINT/SIGTERM 处理。
- [x] 部署：`Dockerfile`（Bun 1.3）、`compose.yaml`（`replicas: 1`，healthz 只映射回环）、完整 `.env.example`。
- [x] 单元测试：M1 14 个 + M2 20 个 = **34 个全部通过**，6 条易错回归全覆盖。
- [x] 真实实例 dry-run：`npm run dry-run` 拉取 **595 条任务 / 15 个项目**，strict 计划 0 条（与实测「无时间字段」一致），全程只读。
- [x] **官方比对夹具**（目标 A / §18.2）：`tests/official-schedule.ts` 逐字移植官方 `schedule-utils.ts`（及 date / due-reminder-lead / task-status / task-reminder-policy 依赖）作为基准，`tests/official-golden.test.ts` 用 28 条黄金数据跑 `(task_id, kind, scheduledAt)` 集合比对，strict 差集为空；并在比对中纠正 2 处与官方不一致（见下）。

**交付物**：`package.json`、`src/{types,config,healthz,scheduler,cli}.ts`、`src/cloud/client.ts`、`src/state/store.ts`、`src/rules/{reminder-plan,time,plan}.ts`、`src/dispatch/{index,message,email,webhook}.ts`、`tests/*.test.ts`、`scripts/probe.mjs`、`Dockerfile`、`compose.yaml`、`.env.example`、`docs/probe-result.md`。

> 实现决策：本机未装 Bun，但 Node v22.22.2 可直接运行 `.ts`（原生类型剥离），因此全部代码用零依赖 TS 编写、`node --test` 直接跑；生产镜像仍按 §9 用 Bun 1.3，代码兼容 Node 22 / Bun 双运行时。

**验收标准**

- [x] 6 条易错回归全过（单元测试）：BASE-18 / 19 / 21 / 23 / 25 / 28。
- [x] strict dry-run 在真实实例跑通，只发 GET、不投递、不写状态库。
- [x] 重启后同一触发点不重发（SQLite 渠道级去重，两轮调度测试覆盖）。
- [x] 关闭 `channels.*` 后 dry-run 计划与 strict 模式相同。
- [x] healthz 只返回 `ok / lastPollAt / lastErrorCount / pendingCount / channelStatus / lastPlanCount`。
- [x] **与官方 `getTaskReminderPlan` 实现的集合比对夹具**：`tests/official-golden.test.ts` 已接入 `npm test`，strict 差集为空（✅ 目标 A 完成）。比对中纠正 2 处一致性缺口（`src/rules/reminder-plan.ts` 的 `shouldSendReminderKind`）：
  - 单一 `start` / `due` 策略下 `review` 仍应触发（官方 `review` 候选仅受 `includeReviewAt` 控制，独立于任务策略）；
  - 单一 `due` 策略下不排 `due-repeat`（官方 `getDueReminderRepeatTimes` 的 `isSingleTaskReminder` 抑制）。
- [x] 真实 SMTP 实发与 `--test-webhook`（v1.7 已完成，见 §12.1）；`--test-email` 无配置时落盘 `data/test-emails.txt` 的文件通道也验证过。
- [x] VPS 上 `docker compose up` 联调（v1.8 在远端 VPS 完成：起服务、挂卷、healthz、真实投递、重启去重，见 §12.2）。

**预算**：实际约 1 轮集中开发（M1 剩余 + M2 一并完成）。

**退出门槛**：✅ 上述「外部条件验收」已由 v1.7（真实渠道）、v1.8（VPS 部署）、v1.9（生产化配置）补齐；M1/M2 的功能与 strict 一致性不受影响。

**风险**：规则引擎是本项目最贵的一块，建议直接移植官方源码文件而非重新推导；长会话上下文累积会显著抬高积分消耗。

---

## 12. M2 · 三类摘要、Webhook 与增强开关

**目标**：补齐摘要类一致规则，交付全部渠道能力，并把 A 类扩展做成「实现了但默认关闭」的可选开关。**状态：已实现（真实渠道端到端联调 v1.7、VPS compose 部署联调 v1.8、生产化补齐 v1.9 均已通过）。**

**前置依赖**：✅ M1 代码完成；strict 基线由 34 个单元测试与 dry-run 守住。

**三态范围**

| 标记 | 本里程碑交付 |
|---|---|
| 【一致】 | `BASE-08/09/10`（morning / evening / weekly 三类摘要及各自 `kind + YYYY-MM-DD` 去重键） |
| 【增强】 | `EXT-01`（Webhook 通道部分）、`EXT-02`（结构化 JSON 与深链补全） |
| 【官方无】 | `EXT-04/05`（签名与渠道重试）、`EXT-11`（失败告警/恢复）、`EXT-16/17/18`（仅日期 09:00、backlog、静默时段，**默认关闭**） |

**任务清单**

- [x] 三类摘要（`src/rules/plan.ts`）：独立开关与时刻、汇总内容（今日到期 / 逾期 / 今日开始 / 专注任务）、`kind + YYYY-MM-DD` 去重键；用「触发窗口 + 按天去重」避免轮询错过整分钟。
- [x] Webhook（`src/dispatch/webhook.ts`）：多 URL、`X-Notify-Timestamp` / `X-Notify-Signature`、5 分钟防重放、指数退避最多 3 次、渠道级独立成败。
- [x] A 类扩展（`src/rules/plan.ts`）：`date_only`（仅日期 09:00 汇总）、`backlog`（24h 节流）、`quiet_hours`（跨午夜顺延、解禁不叠加补发）；配置与 strict 双重默认关闭。
- [x] 失败告警/恢复（`src/scheduler.ts` + `src/cloud/client.ts`）：连续 3 次失败告警、最长 10 分钟退避、恢复通知、60 秒告警节流。
- [x] CLI 补 `--test-webhook`；`.env.example` 补齐全部配置项；`Dockerfile` / `compose.yaml` 落地。
- [x] **真实渠道端到端联调（v1.7，2026-11-15）**：`tests/e2e-channels.mjs` 跑通邮件实发、Webhook 独立验签、渠道级独立重试、跨进程重启不重复投递；同时修复 `src/dispatch/email.ts` 多行 EHLO 丢行导致的真实 SMTP 挂起缺陷。
- [x] **部署联调（目标 D，v1.8）**：真实 VPS 上以独立项目名 / 卷 / 端口起单副本服务，healthz 与管理页 200、挂卷持久化、真实投递一轮、重启后零投递零请求；详见 §12.2。
- [x] **生产化补齐（目标 E，v1.9）**：`healthcheck` / `read_only: true` / `tmpfs` 落地、生产镜像剔除 `scripts/`、新增 `.dockerignore`，远端真实 Docker 验证通过；详见 §12.3。

**交付物**：`src/rules/{time,plan}.ts`、`src/dispatch/{index,message,email,webhook}.ts`、`src/scheduler.ts`、`src/healthz.ts`、`src/cli.ts`、`tests/m2-*.test.ts`、`tests/e2e-channels.mjs`、`scripts/deploy-test.py`、`Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`。

**验收标准**

- [x] morning / evening / weekly 独立开关与 `kind + date` 去重键（单元测试覆盖 morning 窗口触发）。
- [x] 签名可验证、篡改正文与超 5 分钟重放被拒；失败后重试 3 次（单元测试）。
- [x] A 类全关 / strict 下不产生任何扩展触发点（单元测试）。
- [x] 逐项开启 EXT-16/17/18 后差异可归因（开关、节流、顺延均有对应用例）。
- [x] 渠道级独立去重与重试：邮件成功不影响 Webhook 的失败记录（状态库 + 两轮调度测试）。
- [x] `npm run dry-run` 对真实实例跑通（595 条任务 / 15 个项目，全程只读）。
- [x] **真实 SMTP 实发、`--test-webhook` 对接真实 HTTP 接收方并独立验签**（v1.7，见 §12.1）。
- [x] **渠道级独立重试 + 跨进程重启不重复投递**（v1.7，见 §12.1）。
- [x] **VPS compose 部署联调**：起服务、挂卷持久化、healthz 探活、真实投递一轮、重启不重复投递（v1.8，见 §12.2）。
- [x] **生产化配置验收（v1.9，见 §12.3）**：`config --quiet` 通过；镜像不含 `scripts/` / `.env`；容器 `HEALTH=healthy`、`READONLY=true`、卷与 `/tmp` 可写。

### 12.1 v1.7 真实渠道联调记录（2026-11-15）

联调执行器 `tests/e2e-channels.mjs`：本地 mock Cloud API 返回 1 条 `startTime` 为 1 分钟前的任务
（落在 BASE-27 五分钟补发窗口内），本地 Webhook 接收端**独立实现** HMAC 校验，连续启动三个独立
`node src/cli.ts --once --strict` 进程共用一个持久化状态库（独立进程 == 一次重启）。

| 验收点 | 实测结果 |
|---|---|
| 邮件实发 | `node src/cli.ts --test-email` 通过真实 SMTP 发出测试邮件；轮 1 真实投递业务提醒 1 封 |
| Webhook 验签 | `--test-webhook` 走真实 HTTP；5 次请求全部签名有效、时间戳新鲜，错误密钥与「正文加一个空格」均被拒 |
| 渠道级独立重试 | 轮 1 `sent=1 / failed=1`（邮件成功、Webhook 返回 500 并在内部重试 3 次）；轮 2 `sent=1 / duplicates=1`（只重投 Webhook，邮件不重发） |
| 重启不重复投递 | 轮 3 `sent=0 / failed=0 / duplicates=2`，接收端**零新请求** |

安全边界：Cloud 地址临时指向本机 mock、`MINDWTR_TOKEN` 覆盖为假值（真实 token 不参与联调）、
Webhook 只发 127.0.0.1、状态库放系统临时目录且用独立命名空间，全程未向真实云端发任何请求。
唯一对外副作用是真实 SMTP 发出 2 封邮件（用户本次目标明确授权）。
`npm test` 仍 **62/62**（联调脚本不在 `npm test` 用例集内），BASE 规则与 strict 基线未改动。

**预算**：与 M1 剩余合并为约 1 轮集中开发。

### 12.2 v1.8 VPS 部署联调记录（2026-11-15）

用户授权上传含 `MINDWTR_TOKEN` / `SMTP_PASS` 的 `.env` 后，执行器 `scripts/deploy-test.py`
在独立项目名 `notify-test`、独立卷、`127.0.0.1:8789:8788`、单副本下完成联调。
凭据经内存 SFTP 写入（权限 600、过滤 `SSH_URI`、`.dockerignore` 排除 `.env`），
compose 校验只用 `config --quiet`，全程未打印任何配置内容或凭据。

| 验收点 | 实测结果 |
|---|---|
| 起服务 / 挂卷 | `up -d --build` 成功；卷 `notify-test_notify-data` 挂载 `/app/data`；单副本 |
| 健康探活 | `/healthz` 200（`lastErrorCount=0`、`lastPlanCount=4`）、`/admin` 200，重启后仍 200 |
| 真实跑一轮 | 造数刷新后第一次重启：计划 4 / 到点 1 / **成功 1 失败 0**；本地 Webhook 独立验签 `sig_ok=true fresh=true`，`HOOK_HITS=1`，状态库 `sent:1` |
| 重启不重复投递 | 第二次重启：成功 0、`HOOK_HITS` 仍为 1（零新请求）、状态库计数不变；healthz `pendingCount=0` |

⚠️ 该 VPS 出站到 SMTP 587 / 465 均 `ECONNREFUSED`（宿主机直连同样如此，属网络策略），
因此联调阶段临时关闭 SMTP 投递、改用同一 compose 网络内的本地 Webhook 接收端；
**`.env` 里的 SMTP 凭据仍完整注入容器**，未来放行端口或改用中继即可启用。
目标 B（§12.1）已在本机用真实 SMTP 验证过邮件实发，两条链路互补。
联调结束已 `docker compose down` 停掉容器与网络，测试卷保留以便复查。

### 12.3 v1.9 生产化补齐记录（目标 E，2026-11-15）

纯配置改动，产品代码 `src/` 一行未动；本机无 Docker / Bun，全部在远端 VPS 用真实 Docker 验证。

| 改动 | 内容 |
|---|---|
| `compose.yaml` | 新增 `healthcheck`（镜像自带 Bun 请求 `/healthz`，30s 间隔 / 5s 超时 / 3 次重试 / 20s 起步）；`read_only: true`（EXT-15【官方无】）+ `tmpfs /tmp`；头部补生产部署前检查清单 |
| `Dockerfile` | 去掉 `COPY scripts ./scripts`，只保留 `package.json` + `src/` |
| `.dockerignore`（新增） | 统一排除 `.env` / `scripts/` / `tests/` / `data/` / 联调文件，构建上下文不再含凭据与能写云端的造数脚本 |
| `scripts/remote.py` | 同步白名单加入 `.dockerignore`，远端构建上下文规则与本机一致 |
| `scripts/deploy-test.py` | 改为读取项目根目录 `.dockerignore`（单一事实来源），不再内置第二份规则 |

**实测结果**（远端 `sync` → `build` → `prepare` → `up` → `down`，全程凭据脱敏）：

- `docker compose config --quiet` 退出 0、零输出；构建上下文仅 942B（4 层 COPY，无 scripts）。
- 镜像 `/app` 只有 `data/ package.json src/`：`SCRIPTS_DIR=NO`、`.mjs/.py` 数量 0、`ENV_FILE=NO`；
  禁网冒烟仍能加载 `src/rules/reminder-plan.ts`（11 个导出）。
- 隔离容器 `notify-test-app`：`HEALTH=healthy`，两次健康检查退出码均为 0；
  `READONLY=true`、`TMPFS={"/tmp":"size=16m,mode=1777"}`；根文件系统 `touch` 失败（符合预期），
  `/app/data` 与 `/tmp` 可写，卷内 `notify.sqlite / -shm / -wal` 齐全；`/healthz` 与 `/admin` 均 200。
- healthcheck 的 `HEALTHZ_TOKEN` 非空分支已在 **v1.10** 完成端到端验证：临时给服务端注入假 token 后，
  不带 token 的 `/healthz` 返回 401、带 token 返回 200，而 healthcheck 仍 `HEALTH=healthy`（退出码 0 0）、
  `READONLY=true`。详见 §12.4。
- 验证后 `docker compose -p notify-test down`，容器与网络已移除、测试卷保留；
  v1.10 已删除远端 `.env`（含真实凭据）、联调 override、临时鉴权层与接收端，只留源码与 `.dockerignore`。

**未做的部署动作**：`MINDWTR_BASE_URL` 仍指向测试实例，**未擅自切回生产地址** ——
本轮不部署，改动会立刻改变 dry-run 基线。该步骤已固化为 `compose.yaml` 头部与 `README.md` 的部署前检查清单。

### 12.4 v1.10 缺陷修复记录（2026-11-15）

| 问题 | 修复 / 验证 |
|---|---|
| Bun 下 socket 错误 `Error.message` 可能为空串，`??` 兜不住 → `sent_log.last_error` 空白 | 新增 `src/errors.ts` 的 `describeError`（`\|\|` 兜底 + URL 脱敏 + 160 字截断）；`recordDelivery`、调度日志、SMTP/Webhook catch、`--test-webhook` 输出全部走它 |
| fetch / SMTP 异常文本常带完整 Webhook URL（可能含密钥），会被写进状态库与日志 | 同一函数把 `https?://\S+` 替换为 `[url]`；`src/cloud/client.ts` 的 `summarizeError` 改为委托它 |
| healthcheck 鉴权分支只做过脚本级验证 | 远端临时给服务端注入假 token 起实例：`NO_TOKEN_HTTP=401`、`WITH_TOKEN_HTTP=200`、`HEALTH=healthy`（退出码 0 0）、`READONLY=true` |
| 远端联调残留含真实凭据 | 删除远端 `.env` / `compose.override.yaml` / `compose.auth.yaml` / `hook-receiver.mjs`；`down` 后无容器与网络，测试卷保留 |

回归：本地与远端 `npm test` 均 **62/62**（断言加进现有用例，数量不变）、`docker build` 成功；
禁网镜像内 `describeError('')` 与 `describeError(new Error(''))` 均返回「未知错误」、
`'fetch failed: https://…?token=SECRET'` 变成 `'fetch failed: [url]'`，`src/dispatch/index.ts` 与
`src/cloud/client.ts` 均可加载。**BASE 规则与 strict 基线未改动。**

**退出门槛**：✅ 功能实现、单元验收、真实渠道联调、VPS compose 部署联调、生产化配置验收与缺陷修复均完成。**M2 代码已是功能完整的可用版本**，M3/M4 可选。

### 12.5 v1.13 日志级别实现记录（2026-11-15）

| 位置 | 改动 |
|---|---|
| `src/logger.ts`（新增） | `createLogger` / `parseLogLevel` / `LogLevel` / `Logger`；五级数值过滤、`Intl.formatToParts` 稳定时间戳（时区非法回退本地）、`key=value` 结构化字段、`redactUrls` 全量脱敏；可注入 `sink` / `now` 便于测试 |
| `src/errors.ts` | 导出 `redactUrls`，`describeError` 改为复用，日志与状态库共用一条脱敏规则 |
| `src/config.ts` | `logLevel` / `logLevelWarning`；`NOTIFY_LOG_LEVEL` 大小写容错，非法值回退 `info` 并留启动告警；`overrides` 供 CLI 覆盖 |
| `src/cli.ts` | `--log-level=<级别>`（非法值报错退出 1）、启动信息显示当前级别、`--help` 说明、把 logger 注入 cloud / scheduler / healthz；配置错误与命令结果仍用 console |
| `src/scheduler.ts` | `logger?` 注入 + 兼容旧 `log` 单函数注入（只转发 info 及以上，旧用例不变）；新增轮次、拉取、计划、触发点窗口、渠道去重 / 投递结果、退避等 debug 点 |
| `src/cloud/client.ts` | `get()` 记录请求路径 / 查询参数 / 状态 / 耗时 / 网络异常；项目缓存、退避、连续失败与恢复分别给 debug / warn / info；**不打印 url 全文、Authorization 头或响应体** |
| `src/healthz.ts` | 错误改 `logger.error`；debug 只记 pathname 与 method，**刻意不记 `url.search`**（`/healthz` 支持 `?token=`） |
| `tests/logging.test.ts`（新增） | 12 个用例：级别解析与五级过滤、输出格式、URL / 凭据脱敏、配置默认值与非法回退、CLI 覆盖优先级、调度器诊断日志与旧注入兼容、Cloud 客户端不打印 token |

**实测**：本地与远端 `npm test` 均 **74/74**（62 旧 + 12 新），远端 `docker build` 成功；
禁网 Bun 镜像内 `FORMAT=2026-11-15 12:34:56 [INFO ] [notify] Bun 冒烟 ok=true`、
`REDACTED=true`、`NO_SECRET=true`、`INFO_ONLY_COUNT=1`、`PARSE=debug`、`CONFIG_DEFAULT_LEVEL=info`。
只读 `dry-run` 三种行为实测：`--log-level=debug` 打印完整链路（含 4 次 `GET /v1/tasks` 的耗时与
4 条过期跳过的原因）；`silent` 下计划与「未投递未写库」提示照常输出；
`.env` 里填 `trace` 会回退 `info` 并打一条 `WARN`；`--log-level=verbose` 报错退出 1。

**安全边界**：debug 只含路径、状态、耗时、任务 id、触发类型、渠道短名与计数，
不含 token / 密码 / Webhook 地址 / 任务标题 / 正文；`--dry-run` 全程只读，未向生产实例发任何写请求。

**风险**：静默时段会改变发送时刻，必须保证默认关闭且不影响 strict 基准；摘要去重键若误用单一 `digest:YYYY-MM-DD` 会导致 morning/evening 互相吞掉。

### 12.6 v1.15 Webhook 业务响应校验记录（2026-11-15）

**起因**：企业微信 / 钉钉 / 飞书机器人可能在 HTTP 200 里返回 `{"errcode":40058,...}`，
v1.14 及以前只按 `response.ok` 判定，日志显示「投递成功」但群里没有消息，状态库也不记失败。

| 位置 | 改动 |
|---|---|
| `src/dispatch/webhook.ts` | 新增 `parseWebhookBusinessError`：只认 `errcode`（企微 / 钉钉）、`StatusCode` + `StatusMessage`（飞书新版）、`code` + `msg`（飞书旧版）三种形状；`readBusinessError` 只读响应体前 4KB 且读不出来时返回 null，不把已成功的 HTTP 倒扣成失败；`formatBusinessError` 统一 URL 脱敏 + 截断 |
| `postWebhook` | 2xx 且无业务错误才算成功；2xx 有业务错误**立即返回失败、不即时重试**；非 2xx 仍走 `WEBHOOK_MAX_ATTEMPTS` 退避重试，错误文本附带业务码 |
| `src/cli.ts` | `--test-webhook` 按 `config.m3.adapters.kinds[0]` 选择 `deliverPlatformWebhook` 或 `deliverWebhook`，结果与常驻投递同路径；输出显示适配器名 |
| `tests/webhook-response.test.ts`（新增） | 11 个用例：业务码解析（含 0 / 非 0 / 飞书两版 / 脱敏）、不误伤空 body 与自定义 JSON、200 + 业务错误失败且不重试、200 + `errcode=0` 成功、HTTP 500 仍重试 3 次、非 2xx 带业务码、wecom 适配器链路与 text body、URL 与密钥不进 `result.error` |

**为什么不即时重试业务错误**：无效 key、消息格式非法是确定性结果，重发同一份 body 只会刷群，
200ms 级退避对平台限流也太短；状态库记 `failed` 后由下一轮调度（默认 60s）跨轮重投兜底，消息不会丢。
**为什么限制识别形状**：`generic` 是用户自建接收端，返回 `{"code":200}` 之类自有格式很常见，
无条件把非零 code 当失败会误伤。

**实测**：本地与远端 `npm test` 均 **85/85**（74 旧 + 11 新），远端 `docker build` 成功；
禁网 Bun 镜像内 `ERRCODE_ZERO_IS_NULL=true`、`ERRCODE_BAD=40058`、`MASKED=true`、
`NO_SECRET=true`、`PLAIN_JSON_IS_NULL=true`、`POST_200_BUSINESS_FAIL=true ATTEMPTS=1`；
真实企业微信 `node src/cli.ts --test-webhook --log-level=debug` 输出
「Webhook 测试成功（适配器 wecom，第 1 次尝试）」、退出 0，向群发出 **1 条**测试消息（已获授权）。
`dry-run` 全程只读，未向 Mindwtr Cloud 发任何写请求，`.env` 未改动。

### 12.7 v1.16 Coolify 部署教程记录（2026-11-15）

| 交付物 | 内容 |
|---|---|
| `docs/coolify.md`（新增） | Coolify v4 部署教程：纯出站服务的默认选择、Git 仓库前置、六步 UI 配置、干净环境变量清单、域名与鉴权、卷 / 副本 / 预览部署、部署后验证、升级回滚备份、常见坑、安全边界、与原生 Compose 差异速查 |
| `compose.coolify.yaml`（新增） | Coolify 专用编排：`${VAR}` 白名单注入、无 `env_file` / `container_name` / `ports`；保留 `read_only: true` + `tmpfs /tmp`、命名卷、compose 自有 `healthcheck`、`replicas: 1` |

**三个刻意的差异（为什么不能直接用 `compose.yaml`）**：Coolify 的凭据应只存在面板里，
`env_file: - .env` 既要求仓库/部署目录里有 `.env`，又会把 `SSH_URI` 这类本机运维变量带进容器；
`container_name` 与 Coolify 的自动前缀 / 重命名冲突；官方明确建议 Compose 服务不要 `ports:`
（发布宿主端口会绕过域名代理路由），而 Notify 默认根本不需要入站域名。

**安全设计**：编排里故意**不列** `NOTIFY_ALLOW_WRITE` / `NOTIFY_COMPLETE_ACTION`，
代码用内置 `false`，面板里也无法误开云端写端点；`NOTIFY_STATE_PATH` / `HEALTHZ_PORT` 写死，
避免状态库被改到只读根文件系统上。`MINDWTR_TOKEN: ${MINDWTR_TOKEN:?}` 让 Coolify 在缺
token 时直接阻止部署；其余 `${VAR}` 留空即走代码内置默认值（`src/config.ts` 的
`bool` / `number` / `list` 对空串都回退默认）。

**实测**：只读探查到目标 VPS 为 **Coolify 4.7.5** / Traefik v3.7 / 网络 `coolify` /
8788 与 8789 空闲 / 无同名容器；远端真实 `docker compose -f compose.coolify.yaml config --quiet`
在缺 token 时退出 1（`required variable MINDWTR_TOKEN is missing a value`），
注入假值后退出 0，渲染结果保留 `read_only`、`tmpfs`、卷、`replicas: 1`、`healthcheck`。
**未创建 Coolify 资源、未部署、未发任何渠道消息**（教程明确标注需用户自行执行）。
`npm test` **85/85**、`dry-run` 只读正常；BASE 规则与 strict 基线零改动。

### 12.8 v1.17 GitHub 仓库与 CI 记录（2026-11-15）

| 项 | 内容 |
|---|---|
| 目标仓库 | `https://github.com/zlay0701/mindwtr-notify`（public，main） |
| 长期约定 | 所有改动提交到该仓库；**绝不提交敏感信息**（已写入用户级 + 项目级 MEMORY.md） |
| 排除项 | `.env`、`data/`、`.workbuddy/`、联调产物、`__pycache__/`、私钥 / 证书 / SQLite |
| 提交方式 | 白名单 `git add`（52 个文件）；提交作者用 GitHub noreply 邮箱 |
| 提交身份 | 助手提交为 `Notify Agent <notify-agent@users.noreply.github.com>` 且**不签名**（`-c commit.gpgsign=false`），所有者提交为 `zlay0701 <18520556+zlay0701@users.noreply.github.com>` 并沿用 `commit.gpgsign=true`（签名 / Verified）；仓库默认身份保持所有者，助手通过 `scripts/agent-git.sh` 只对单次命令覆盖身份与签名 |
| CI | `.github/workflows/ci.yml`：单测 / 镜像构建 + 禁网冒烟 / 两份编排语法校验 / no-secrets 防呆 |
| 敏感审计方法 | 从 `.env` 取 11 个真实值（含 Webhook URL 的 key 参数），在全部候选文件里做子串比对；只输出文件名与键名，不输出值 |

**审计结论**：候选文件中唯一命中的是公开 Cloud 域名（`MINDWTR_BASE_URL`）与公共 SMTP
主机名（`SMTP_HOST`），分别出现在交接包的配置说明、联调脚本的「非生产地址硬检查」注释里，
属于部署文档必要信息而非凭据；`scripts/deploy-test.py` 与 `tests/e2e-channels.mjs` 里的
本地假密钥均不等于任何真实值。真实 token / 密码 / SSH 连接串 / Webhook key / 收件邮箱
**未出现在任何候选文件**。

**当时的阻塞（已解决）**：连接器的 GitHub App 调用 `POST /user/repos` 返回 403
`Resource not accessible by integration`；本机 `git credential` 中的凭据对 API 返回 401。
用户在 GitHub 网页手动创建空仓库并首次 `git push` 后解决，后续见 §12.9。

**未改动**：产品代码、BASE 规则、strict 基线、`.env`。`npm test` **85/85**，`dry-run` 只读。

### 12.9 v1.18 仓库上线与 CI / 部署验证（2026-11-15）

| 项 | 结果 |
|---|---|
| 远端 main | 首次上线 `63c382c`（4 个 commit）；文档提交 `587e823` 已推送；作者 `Notify Agent`、未签名 |
| 受版本控制文件 | 54 个；无 `.env` / `data/` / `.workbuddy/` / 私钥 / SQLite |
| GitHub Actions `CI` | **连续两次 completed / success**（`63c382c` → run 43730537851，`587e823` → run 43780028017）；3 个 job 全绿（单测 / 镜像与编排校验 / 敏感信息防呆），徽章 passing |
| 远端 clone 验证 | `git clone` commit `63c382c`；`npm test` 85/85；两份编排 `config --quiet` 退出 0；`docker build` 成功 |
| 远端 compose 部署 | `healthz` 200、`admin` 200、`HEALTH=healthy`、`READONLY=true`、卷 `-> /app/data`；随后 `down` 并清理目录 / 卷 / 网络 |
| 副作用 | 假 token + 不可达 Cloud 地址 + 渠道全关：不连真实云端、不发消息；`.env` 未改动 |

**提交身份分层（用户 2026-11-15 要求）**：助手提交用 `scripts/agent-git.sh`
（`Notify Agent <notify-agent@users.noreply.github.com>`、`-c commit.gpgsign=false` 不签名）；
所有者自己提交沿用仓库默认 `zlay0701` + `commit.gpgsign=true`（签名 / Verified）。
脚本只对单次命令覆盖，不改 `.git/config`。

**远端部署命令的可复制形态**见 `docs/deployment.md` §2.1 与 `docs/coolify.md`；
本次验证用的脱敏 `.env` 与端口 override 只存在于临时目录，验证后已删除。

---

## 13. M3 · 可选增强（标签 / 平台适配器 / 双向完成）

**目标**：接入国内常用机器人与自动化，按任务标签做细粒度路由。**状态：已实现（2026-11-13，双向完成的写端点未实测、默认永不触发）· 可选。**

**前置依赖**：✅ M2 已实现。双向完成的冲突评审仍在「待用户决策」，见下方只读边界。

**三态范围**：全部 `EXT-19`【官方无】前半 —— 标签约定规则、Webhook 平台适配器、双向完成。**不含任何 `BASE`【一致】规则**；标签只过滤渠道，不改写触发计划。

**任务清单**

- [x] 标签约定：`#silent` / `@silent` 全静默、`#notify-email` 只发邮件、`#notify-webhook` 只发 Webhook（含适配器渠道）。支持正文内 `#tag` / `@context` 与 `tags` / `contexts` 数组两种来源。
- [x] 平台适配器：钉钉（加签，`sign`/`timestamp` 追加到 URL）、企业微信群机器人（无签名、`text` 格式）、飞书（`timestamp`/`sign` 放 JSON body）。三者复用同一套 POST 重试逻辑。
- [x] 双向完成（可选）：`src/actions/complete.ts` 已实现 `POST /v1/tasks/:id/complete` 的构造与调用，但**默认永不发写请求**。
- [x] 各适配器单测与固定签名向量。
- [ ] `complete` 端点实测与 If-Match 验证 —— **按用户「只能查询、不能更改云端数据」的约束主动不做**，见下方边界说明。

**只读边界（本里程碑最重要的约束）**

用户明确要求对 Cloud 实例「只能查询，不能更改里面的数据」。因此：

1. `completeTask` 必须**同时**打开 `NOTIFY_ALLOW_WRITE=true` 与 `NOTIFY_COMPLETE_ACTION=true` 才会构造 POST；两者默认均为 `false`。
2. CLI、Scheduler、Dispatcher **均不调用该函数**，代码中不存在任何自动写路径；`src/cloud/client.ts` 的双白名单仍只允许 `GET`。
3. 与 `EXT-15`【官方无】纯只读原则存在冲突；文档只在 **PATCH** 上写明支持 `If-Match`，`complete` 端点是否支持**未经官方确认**。启用前需用户单独评审并授权一次写实测。
4. 本次开发全程未向真实实例发出任何 POST/PUT/PATCH/DELETE。

**交付物**：`src/rules/tag-policy.ts`、`src/dispatch/adapters.ts`、`src/actions/complete.ts`、`tests/m3.test.ts`；`src/config.ts` 增加 M3 配置段，`src/dispatch/{webhook,index,message}.ts` 与 `src/scheduler.ts` 接入适配器与标签过滤，`.env.example` 补齐 M3 变量，`package.json` 的 `test` 纳入 M3 用例。

**验收标准**

- [x] 每个适配器单测通过：钉钉 / 飞书签名用固定向量校验，企微格式校验，适配器 POST 失败重试（第 3 次成功）。
- [x] 标签规则不改写任何 BASE 触发点（专门有一条用例断言计划集合不变）；规则默认关闭时渠道列表原样放行。
- [x] 双向完成的只读闸门：默认配置「连 HTTP 请求都不发」、只开一道开关仍拒绝、两道都开才构造 POST（mock，不触达真实实例）。
- [x] 全量测试 **46/46 通过**；`npm run dry-run` 对真实实例仍拉取 595 条任务 / 15 个项目、计划 0 条、未投递未写库。
- [ ] `read_only: false` 显式评审记录与 complete 端点实测：**未做，需用户单独授权**。

**预算**：8–12 轮 / 250–450 积分（实际消耗含在 M1+M2 同一会话内）。**退出门槛**：可选，不做不影响 M2 交付的可用性；当前除写端点实测外均已满足。

---

## 14. M4 · 管理平台与多命名空间

**目标**：提供只读可视化与多实例隔离。**状态：已实现（2026-11-13，验收通过）· 可选。**

**前置依赖**：✅ M2 完成（可与 M3 并行；M3 代码已完成）。

**三态范围**：全部 `EXT-19`【官方无】后半 —— 管理页面、多命名空间。**不含任何 `BASE`【一致】规则**；管理页只是本地状态库与计划缓存的只读视图，不新增、不删除、不改写任何触发点。

**任务清单**

- [x] 只读管理页（`src/admin.ts`）：`GET /admin` 自包含 HTML + `/admin/api/{overview,sent,failed,channels,upcoming,audit}` 六个只读 JSON 接口，覆盖已发记录、失败重试、渠道状态、下一批待触发提醒；与 `/healthz` 共用端口、零外部资源，动态值一律用 `textContent` 渲染。
- [x] 手动触发 / 重发入口（需鉴权）：`POST /admin/api/retry` 必须同时满足 `NOTIFY_ADMIN_RETRY=true` + 配置了 `NOTIFY_ADMIN_TOKEN`（或回退 `HEALTHZ_TOKEN`）+ 请求头 token 恒定时间校验通过；重发只把本地记录置回「可重试」，实际投递仍由 BASE-27 补发窗口决定。
- [x] 多命名空间：配置（`NOTIFY_NAMESPACE` + JSON `namespaces.<ns>` 分段覆盖）、状态库（路径自动派生 `data/notify-<ns>.sqlite`）、去重键（`ns=<ns>:` 前缀 + `sent_log.namespace` 列过滤）三层隔离，`meta` 键同样隔离；默认 `default` 与 M1–M3 完全兼容，旧库自动补列、历史记录归入 `default`。
- [x] 权限与审计日志：管理接口统一鉴权（token 走 `X-Admin-Token` 头，不进 URL / 日志），`audit_log` 表按 namespace 记录鉴权失败、拒绝与成功的重发；错误文本脱敏（隐藏 URL 与长串标识）。

**只读边界（本里程碑最重要的约束）**

1. 管理页所有展示接口是 `GET`；唯一的 `POST /admin/api/retry` 只写**本地状态库**的一条记录状态，不向 Mindwtr Cloud 发出任何请求，也不触碰 `/complete`。Cloud 客户端的 GET 双白名单不变。
2. 页面源码、HTML 与全部 JSON 均不含 `MINDWTR_TOKEN`、管理 token、`WEBHOOK_SECRET`、SMTP 密码、Webhook URL 与任务正文；管理 token 由用户在浏览器临时输入，只放请求头。
3. 「下一批待触发提醒」取 `Scheduler.upcoming()` 的最近一轮计划缓存，不重新拉取云端、不重算计划。
4. 本次开发全程未向真实实例发出任何 POST / PUT / PATCH / DELETE。

**交付物**：`src/admin.ts`、`src/state/namespace.ts`；`src/state/store.ts` 增加 namespace 列（含旧库无损迁移）与列表 / 计数 / 重试 / 审计接口；`src/config.ts` 增加 M4 配置段；`src/healthz.ts` 抽出共享鉴权比较并支持 `/admin` 路由委托；`src/scheduler.ts` 增加 `upcoming()`；`src/cli.ts` 组装管理页；`.env.example` 补齐 M4 变量；`tests/m4.test.ts`（11 个用例）纳入 `npm test`；`README.md` / `HANDOFF.md` 同步。

**验收标准**

- [x] 页面不泄露 token：单元测试用 5 个假凭据（云端 token / 管理 token / healthz token / Webhook secret / SMTP 密码）逐一断言页面 HTML 与全部 JSON 响应都不包含原文；失败原因里的 URL 与长串标识被脱敏。
- [x] 命名空间之间不串数据：同一 SQLite 文件内 `work` / `home` 两个实例的 `hasSent` / `listRecords` / `channelStatus` / `pendingCount` / `meta` / `audit` 全部互不干扰；不同文件与旧库升级（不重发历史记录）另有对应用例。
- [x] 手动重发受 `HEALTHZ_TOKEN` 或独立鉴权保护：总开关关闭 → 403；无 token → 入口关闭（403）；错误 token → 401；正确 token → 200 且写审计；三种拒绝路径均不改动本地记录。
- [x] 权限与审计日志：鉴权失败、拒绝、成功重发都留痕，审计详情不含 token 原文，且按 namespace 隔离。
- [x] strict 一致性：`(kind, scheduledAt, dedupeKey)` 计划集合在 `default` 与 `work` 命名空间下完全相同；`Scheduler.upcoming()` 只读缓存、不额外拉云端（专门用例断言 Cloud 请求次数不变）。
- [x] 全量测试 **62/62 通过**；`npm run dry-run` 对真实实例仍拉取 595 条任务 / 15 个项目、计划 0 条、未投递未写库。

**预算**：8–12 轮 / 250–450 积分（实际在单个会话内完成）。**退出门槛**：可选，已满足。

**风险**

- 旧状态库首次运行会补 `namespace` 列并新建 `audit_log` 表，属本地 schema 初始化，不改任何业务数据；`default` 的裸去重键保持不变，因此不会重发历史提醒。
- 管理页与 `/healthz` 共用端口且 compose 只映射回环；若需远程访问请自行走 SSH 隧道，并务必配置 `NOTIFY_ADMIN_TOKEN`。
- dry-run 期间曾出现一次 Cloud API 请求超时（拉取 0 条），复跑即恢复 595/15；属经 Cloudflare 代理的瞬时抖动，不是代码缺陷。

---

# Part III · 规则清单与验收矩阵（供里程碑引用）

## 15. 清单 A · 与官方保持一致（BASE-01…29，全部【一致】）

> 29 条全部为基线，不可偏离、不可关闭。里程碑引用编号即可，规则细节集中在此。

### A1 · 触发类型全集

| 编号 | 一致项 | 官方依据（kind / 触发点） | 里程碑 |
|---|---|---|---|
| BASE-01 | 开始提醒 | `start` = `startTime` | M1 |
| BASE-02 | 开始前提醒 | `start-advance` = `startTime − startReminderLeadMinutes`；默认关，不改变任务实际开始时间 | M1 |
| BASE-03 | 截止提醒 | `due` = `dueDate` | M1 |
| BASE-04 | 截止提前提醒 | `due-advance` = `dueDate − dueReminderLeadMinutes`；默认关，原有截止提醒仍保留 | M1 |
| BASE-05 | 截止重复提醒 | `due-repeat` = `dueDate + n × repeatReminderMinutes`；次数见 BASE-25 | M1 |
| BASE-06 | 任务回顾提醒 | `review` = `task.reviewAt`；**不受 skip 策略影响** | M1 |
| BASE-07 | 项目回顾提醒 | `project-review` = `project.reviewAt`；排除已删除 / 已归档项目 | M1 |
| BASE-08 | 晨间简报 | `digest:morning`，默认 09:00，今日到期 + 逾期 + 专注任务 | M2 |
| BASE-09 | 晚间回顾 | `digest:evening`，默认 20:00 | M2 |
| BASE-10 | 每周回顾 | `digest:weekly-review`，默认周日 18:00 | M2 |
| BASE-11 | 番茄钟 / Snooze / Dismiss / iOS 角标 / 设备通知权限 | 客户端本地能力，不模拟、不实现（见 §17） | — |

### A2 · 字段字典与任务级参数来源

| 编号 | 一致项 | 官方依据 |
|---|---|---|
| BASE-12 | 字段真名与合法值 | `task-sync-schema.ts`：`dueDate` / `startTime` / `reviewAt`；`dueReminderLeadMinutes` 整数 `0–10080`（UI 预设 `5/15/30/60/1440/2880/10080`）；`startReminderLeadMinutes` 仅 `0/5/15/30/60`；`repeatReminderMinutes` 仅 `5/10/15/30/60`；非法值按「未设置」处理 |
| BASE-13 | 其余过滤/元数据字段 | `reminderPolicy`、`suppressMindwtrReminders`、`cancelledAt`（`status=archived` 且带此字段＝已取消，无 `completedAt`、不生成下一次重复）、`completedAt`、`deletedAt`、`archivedAt`、`projectArchivedAt`、`rev`、`recurrence`、`description` |
| BASE-14 | 任务级参数只从任务字段读取 | 配置文件不覆盖单任务的提前量、重复间隔、发送策略 |
| BASE-15 | 通知正文含任务描述 | `buildReminderNotificationBody`，正文带去 Markdown 的 `description` |

### A3 · 发送 / 跳过策略（`task-reminder-policy.ts`）

| 编号 | 一致项 | 官方依据 |
|---|---|---|
| BASE-16 | 策略优先级 | `reminderPolicy` > `suppressMindwtrReminders === true` → `skip` > 默认 `send`；五态 `inherit / send / skip / start / due` |
| BASE-17 | 默认值继承 | `inherit` → 全局 `taskReminderDefault`（初始 `send`）；默认值经 GTD 设置同步组共享，单任务选择随任务同步，设备通知开关留在本机；旧版 ≤1.3.6 行为不同 |
| BASE-18 | `skip` 语义 | 撤销待发的开始/截止提醒及其重复提醒，不删除重复间隔；`review` 仍触发 |
| BASE-19 | 单一提醒策略 | `start` / `due` 只发该一种 kind；设置对应提前量时普通 start/due 提醒被抑制 |
| BASE-20 | 设备级四类开关 | `notificationsEnabled` / `startDateNotificationsEnabled` / `dueDateNotificationsEnabled` / `reviewAtNotificationsEnabled`（默认均开），映射为 `official_rules.include_*` |

### A4 · 时间与数值规则

| 编号 | 一致项 | 官方依据 |
|---|---|---|
| BASE-21 | 「带时间」判定 | `hasTimeComponent(dateStr)` = `/[T\s]\d{2}:\d{2}/.test(dateStr)`；仅日期形如 `2026-11-13`，`T00:00` 算带时间 |
| BASE-22 | 仅日期不排任何提醒 | `parseExplicitReminderDate`：false 时 start/due/review/advance/repeat 全部不排；EXT-16 开启后才叠加 |
| BASE-23 | 提前量算术 | `lead % 1440 === 0` → 按日历日回退（`setDate`），跨 DST 保持同一本地时刻；否则按分钟回退 |
| BASE-24 | 变更重排 / 不补发 | 改时间自动重排；移除时间停止安排但保留提前量；设置时提前点已过不补发 |
| BASE-25 | 重复提醒有界 | `min(8, floor(120 / interval))`，窗口 120 分钟：5/10/15 分＝8 次，30 分＝4 次，60 分＝2 次；关掉重复仍发首次截止提醒 |
| BASE-26 | 摘要默认时刻 | morning 09:00 / evening 20:00 / weekly 周日 18:00，各自独立开关与时间 |
| BASE-27 | 补发窗口 | `resolvePollCatchUpMs` 依据 `lastPollAt`，下限 15s、上限 `MAX_CATCH_UP_MS = 5 分钟`；桌面端 `CHECK_INTERVAL_MS = 15s`、store 变更 debounce 750ms |

### A5 · 过滤、去重语义

| 编号 | 一致项 | 官方依据 |
|---|---|---|
| BASE-28 | 活跃范围 | `isTaskActionable` 排除 `done` / `archived` / `reference` → 活跃为 `inbox` / `next` / `waiting` / `someday`；另排除 `deletedAt` / `cancelledAt` / `completedAt`；归档或已删除项目中的任务不提醒（优先 `projectArchivedAt`） |
| BASE-29 | 去重键与「只发一次」语义 | 任务＝每任务 + `scheduledAt.toISOString()`；截止重复＝`${dueDate}#${index+1}`；项目回顾＝每项目 + ISO 时间戳；每日摘要＝**kind + `YYYY-MM-DD`**（morning/evening 分开）；每周回顾＝`YYYY-MM-DD`。官方用进程内 Map，本服务用 SQLite 实现同一语义（EXT-06/07【增强】） |

## 16. 清单 B · 扩展逻辑（EXT-01…20）

> 「关闭后」＝关闭该扩展时回落到哪条 BASE 规则。E/S/A 只是组织分组，归属以「标记」列为准。

### 16.1 E 类 · 载体扩展（默认启用）

| 编号 | 标记 | 扩展项 | 依赖 | 关闭后 | 里程碑 |
|---|---|---|---|---|---|
| EXT-01 | 【增强】 | 输出到外部 SMTP 邮件 + 通用 Webhook（替代本机通知） | 全部 BASE | `--dry-run` 只打印计划 | M1 邮件 / M2 Webhook |
| EXT-02 | 【增强】 | 结构化 JSON 消息：`event`、`trigger`、`digest`、`links.app` 深链 | BASE-01…10 | 退化为纯文本 | M2 |
| EXT-03 | 【官方无】 | 数据最小化：外发不含 `attachments`/`assignedTo`/`contexts`/`tags`；汇总类不含 `description` | BASE-15 | 汇总类也带描述 | M1 |
| EXT-04 | 【官方无】 | HMAC-SHA256 签名（`X-Notify-Timestamp` + `X-Notify-Signature: sha256=<hex>`，签名串 `${timestamp}.${rawBody}`，5 分钟防重放） | EXT-01 | 不发签名头 | M2 |
| EXT-05 | 【官方无】 | 多 Webhook URL + 渠道级失败重试（指数退避，最多 3 次） | EXT-01 | 单 URL、不重试 | M2 |

### 16.2 S 类 · 工程与可靠性扩展（默认启用）

| 编号 | 标记 | 扩展项 | 依赖 | 关闭后 | 里程碑 |
|---|---|---|---|---|---|
| EXT-06 | 【增强】 | SQLite（WAL）持久化去重，跨重启幂等 | BASE-29 | 进程内 Map（对齐官方会话内语义） | M1 |
| EXT-07 | 【增强】 | 去重键追加 `channel` 维度，各渠道独立成败与重试 | BASE-29 | 官方单维去重键 | M1 |
| EXT-08 | 【增强】 | 轮询间隔默认 60s 可配（官方 15s；设 15 即完全对齐） | BASE-27 | 设 15 | M1 |
| EXT-09 | 【增强】 | 分状态拉取（每轮 4 次 HTTP）+ 分页 + 按 id 去重、按 `rev` 取新 | BASE-28 | 远程 API 必需适配 | M0 验证 / M1 实现 |
| EXT-10 | 【增强】 | 项目缓存：启动及每 10 分钟刷新 `GET /v1/projects`（名称、归档、`reviewAt`） | BASE-07/28 | 无项目名、归档过滤降级 | M1 |
| EXT-11 | 【官方无】 | Cloud API 连续失败 3 次告警 + 指数退避（最长 10 分钟/轮）+ 恢复通知 | — | 静默失败 | M2 |
| EXT-12 | 【官方无】 | `GET /healthz`（`ok/last_poll_at/last_error_count/channel_status/pending_count`；渠道状态取上次投递缓存，可选 `HEALTHZ_TOKEN`） | — | 无探活端点 | M1 |
| EXT-13 | 【官方无】 | 调试 CLI：`mwnotify --dry-run` / `--strict` / `--test-email` / `--test-webhook` / `--once` / `probe` | — | 无调试入口 | M0 起 |
| EXT-14 | 【增强】 | 单实例约束 `replicas: 1`（官方桌面端天然单进程） | BASE-29 | 多实例重复发送 | M1 |
| EXT-15 | 【官方无】 | 纯只读访问 Cloud API（官方客户端会写任务，本服务新增此边界） | — | 放开需评估 `rev` 冲突 | M0 起 |
| EXT-20 | 【官方无】 | 分级日志 `NOTIFY_LOG_LEVEL` + CLI `--log-level`（debug/info/warn/error/silent，默认 `info`；统一 URL 脱敏；命令输出不受级别过滤） | — | 固定输出全部诊断（等价 `debug`） | v1.13 |

> EXT-08 不改变 BASE-21…27 的触发点计算，60s 内到点仍由 BASE-27 的 5 分钟窗口覆盖。EXT-15：v0.4 起移除「回写 `pushCount`」，PATCH 会抬高 `rev` 并触发所有客户端同步。

### 16.3 A 类 · 新增触发点 / 改发送时刻（全部【官方无】，**默认关闭**）

| 编号 | 标记 | 扩展项 | 依赖 / 冲突 | 关闭后（＝严格一致） | 里程碑 |
|---|---|---|---|---|---|
| EXT-16 | 【官方无】 | 仅日期任务当日提醒：`date_only_remind_at` 默认 09:00 发一条并计入晨间简报；判定仍严格用 BASE-21 正则 | 叠加 BASE-22 | 仅日期完全不提醒，仅出现在摘要「今日到期」 | M2 |
| EXT-17 | 【官方无】 | 积压逾期汇总 backlog：首次或距上次 >24h 且确有逾期任务时发一条清单（节流） | 叠加 BASE-03/05，不替换逐条提醒 | 无启动汇总，只走官方 due-repeat 节奏 | M2 |
| EXT-18 | 【官方无】 | 静默时段 `quiet_hours`：静默期顺延，解禁后只发一条最新状态、不叠加补发 | 改变发送时刻，与 BASE-01…10 冲突 | 按官方触发时刻立即发送 | M2 |
| EXT-19 | 【官方无】 | 后续候选：标签规则、平台适配器、双向完成（M3）；管理页面、多命名空间（M4） | M3+ | 无 | M3 / M4 |

> **用户此前四项决策的落位**（能力全保留，但不改写默认行为）：仅日期 09:00 → EXT-16 默认关；60s 轮询 → EXT-08 工程参数；单任务带描述 → BASE-15【一致】，汇总不带 → EXT-03【官方无】；SQLite / 渠道维度 / 外发通道 → EXT-01/06/07【增强】。

## 17. 明确不实现（【一致】）

番茄钟完成提醒、Snooze / Dismiss 交互、iOS 角标计数、设备通知权限与开启状态、Web 标签页节流补偿、Android 精确闹钟权限、Linux 通知守护进程 —— 均为客户端本地能力，服务端不可知，不模拟也不伪造（BASE-11）。官方 ICS 订阅源与 iOS 角标排除「归档/删除项目中的任务」的**过滤规则**已吸收进 BASE-28。

## 18. 一致性验收矩阵

### 18.1 分层约束

```
┌──────────────────────────────────────────────────────────┐
│ A 类 EXT-16…19【官方无】 默认关闭 · strict_mode 强制关闭     │ ← 会改变触发计划
├──────────────────────────────────────────────────────────┤
│ E/S 类 EXT-01…15【增强】+【官方无】 默认启用 · 与判定正交   │
├──────────────────────────────────────────────────────────┤
│ 清单 A BASE-01…29【一致】 不可改写 · 判定唯一来源           │
└──────────────────────────────────────────────────────────┘
```

### 18.2 验收方法（M1 与 M2 结束各跑一次）

1. **计划比对**：同一份任务数据集（`reminderPolicy`、提前量、仅日期、已取消、归档项目、`reviewAt`、重复间隔样本），官方 `schedule-utils.getTaskReminderPlan` vs `mwnotify --dry-run --strict`，按 `(task_id, kind, scheduledAt)` 集合比对，**差集必须为空**。✅ 已实现为单元级夹具 `tests/official-golden.test.ts`（基准 `tests/official-schedule.ts` 逐字移植官方 `schedule-utils.ts` 及其依赖），28 条黄金数据 / 3 个用例，strict 差集为空并已纳入 `npm test`。
2. **扩展归因**：逐项开启 EXT-16/17/18 后，每条差异必须能归因到某个已开启的 EXT 编号；无法归因即判定破坏基线。
3. **回归用例**：BASE-18 / 19 / 21 / 23 / 25 / 28 六条易错规则。
4. **渠道不影响判定**：关闭 `channels.*` 后，dry-run 计划与 strict 模式完全相同。

### 18.3 差异归因表

| 观察到的差异 | 允许归因 | 禁止 |
|---|---|---|
| 多一条 `date_only` 提醒 | EXT-16【官方无】已开启 | 把 BASE-22【一致】改成「默认提醒」 |
| 多一条 `backlog` 汇总 | EXT-17【官方无】已开启 | 取消 BASE-05【一致】的逐条 due-repeat |
| 提醒时刻被顺延 | EXT-18【官方无】已开启 | 修改 BASE-01…10【一致】的触发点计算 |
| 同一触发点发两封邮件 | 不允许 | 任何 BASE/EXT 组合都不得出现 |
| 少发 `review` | 不允许 | `skip` 不能连带关掉 review（BASE-18） |
