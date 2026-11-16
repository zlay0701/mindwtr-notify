# Notify 部署指南（Docker Compose）

> 对应 `spec.md` **v1.25**。本文只讲「怎么跑起来、怎么运维」；规则以 `spec.md` 为准，
> 每个配置项的含义见 [配置参考](configuration.md)，管理页怎么用见 [页面操作手册](admin-guide.md)，
> 调用哪些云端接口见 [Cloud API 调用清单](cloud-api.md)，
> 出站 POST 的数据格式见 [Webhook 输出数据格式清单](webhook-payload.md)，
> **用 Coolify 面板部署见 [Coolify 部署教程](coolify.md)**。

---

## 1. 先理解这个服务

Notify 是**旁路只读服务**：定时用 `GET` 从自托管的 `mindwtr-cloud` 拉任务与项目，
按官方规则算出提醒触发点，再转发到邮件 / Webhook。它**不接管客户端提醒、不改写任务数据**，
对云端始终只有白名单内的 GET 请求。

| 组件 | 位置 | 说明 |
|---|---|---|
| Notify 容器 | `mindwtr-notify` | Bun 1.3 直接跑 TypeScript，零第三方依赖、无需编译 |
| 状态库 | 卷 `notify-data` → `/app/data/notify.sqlite` | 渠道级去重记录；**丢了就会重复投递** |
| 本地端点 | 容器内 `8788` | `/healthz` 运行指标 + `/admin` 只读管理页，只映射到宿主机回环 |
| 上游 | `MINDWTR_BASE_URL` | 走公网 HTTPS，与 Cloud 容器不在同一网络也能跑 |

⚠️ **单实例硬约束**：没有 leader election，`replicas: 1`。
起两个副本、或让两套 Compose 共用同一个状态库卷，都会**重复发送**。

### 1.1 它到底调用了哪些 Cloud 接口

服务运行时（常驻轮询）**只发两类 GET**：

| 方法 | 路径 | 参数 | 频率 |
|---|---|---|---|
| `GET` | `/v1/tasks` | `status=<状态>&limit=100&offset=<n>` | 每轮按 `inbox/next/waiting/someday` 四状态分别拉取并按 `total` 翻页，生产实例实测约 9 次/轮 |
| `GET` | `/v1/projects` | `limit=100` | 结果缓存 10 分钟，实际 HTTP 约每 10 分钟 1 次 |

`GET /health` 与 `GET /v1/tasks/:id` 虽然在只读白名单里，但**运行时没有调用点**；
探针、造数脚本、部署联调脚本各自另有请求，也都不属于产品服务行为；
对生产实例的 POST / PUT / PATCH / DELETE 与 `/complete` 一律禁止。
**完整清单（调用链、参数、请求量估算、认证与响应要点、哪些只是「允许但不用」）见
[Cloud API 调用清单](cloud-api.md)。**

---

## 2. 前置条件

| 条件 | 检查方式 |
|---|---|
| Docker Engine 24+ 与 Compose v2 | `docker version`、`docker compose version` |
| 能访问 Cloud 的健康端点 | `curl -sS https://<你的-cloud-域名>/health` → `{"ok":true}` |
| **完整** bearer token | capture-only token 只能 `POST /v1/capture`，在 `/v1/tasks` 会 403 |
| 至少一个投递渠道配好 | 否则服务能跑，但只会记录计划、不会发任何提醒 |
| 约 200MB 磁盘 | 镜像约 147MB，状态库卷很小 |

> 本机开发期若 `dry-run` 报 `fetch failed`，多半是本机代理端口不一致（命令行代理变量与浏览器/系统代理不同，
> Node `fetch` 默认不读代理变量）。**VPS 走公网直连不需要任何代理设置**，见 `HANDOFF.md` §7。

### 2.1 从 GitHub 仓库获取代码（推荐）

代码托管在公有仓库 [zlay0701/mindwtr-notify](https://github.com/zlay0701/mindwtr-notify)。
仓库里**不含任何凭据**：`cp .env.example .env` 后只在服务器上填写，权限设 600，绝不提交。

```bash
git clone https://github.com/zlay0701/mindwtr-notify.git
cd mindwtr-notify
cp .env.example .env
chmod 600 .env
# 编辑 .env：填 MINDWTR_TOKEN、确认 MINDWTR_BASE_URL 是生产地址、配好渠道
docker compose config --quiet     # 别用裸 config，它会展开 env_file 明文
docker compose up -d --build
```

> `.gitignore` 已忽略 `.env` / `data/` / `.workbuddy/`、私钥、证书与 SQLite；
> CI（`.github/workflows/ci.yml`）每次 push 都会跑单测、镜像构建与「敏感文件防呆」。
> 仓库暂不可用时，也可用 `python scripts/remote.py sync` 从本机按白名单同步源码（不含 `.env`）。

---

## 3. 五步部署

```bash
# 1) 准备配置（.env 从不提交，.gitignore 已排除）
cp .env.example .env
#    填入 MINDWTR_TOKEN（完整 bearer token），并按需启用 SMTP / WEBHOOK

# 2) 确认指向生产实例（开发期常指向测试实例）
grep '^MINDWTR_BASE_URL=' .env

# 3) 部署目录的 .env 保持「最小化」：只写服务需要的键。
#    本机开发用的那份可留着 SSH_URI，但不要把它复制进部署目录（原因见 §6）。
chmod 600 .env

# 4) 校验配置：必须带 --quiet，零输出、退出 0 才算通过
docker compose config --quiet
echo "exit=$?"

# 5) 构建并后台启动
docker compose up -d --build
```

启动后三连验证：

```bash
docker compose ps                                   # STATUS 应为 Up (healthy)
curl -sS http://127.0.0.1:8788/healthz              # JSON 指标，ok 应为 true
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/admin   # 200
docker compose logs --tail 20 mindwtr-notify        # 首轮「计划 N 条 / 到点 M 条」
```

> ❌ **绝对不要**用裸 `docker compose config` 做校验：Compose v5.7.1 实测会把 `env_file`
> 展开成明文 `environment` 打在终端上，`MINDWTR_TOKEN` / `SMTP_PASS` 会一起泄露。
> 一旦误执行，请立即轮换凭据。

---

## 4. 部署前检查清单（逐条确认再 `up`）

| # | 检查项 | 为什么 |
|---|---|---|
| 1 | `.env` 的 `MINDWTR_BASE_URL` 是**生产地址** | 开发期常指向测试实例；`.env.example` 里已是生产值，可直接对照 |
| 2 | 目录里没有 `compose.override.yaml` | 联调覆盖会关掉 SMTP、把 Webhook 指向本地接收端；Compose 会自动加载同名文件 |
| 3 | 校验只用 `config --quiet` | 见上方红色警告 |
| 4 | `replicas: 1`，且没有第二份 Compose 指向同一状态库卷 | 多实例会重复投递 |
| 5 | `NOTIFY_STATE_PATH` 仍指向卷 `/app/data` | 容器根文件系统 `read_only: true`，改到别处会写失败 |
| 6 | 若用邮件渠道：VPS 出站 587 / 465 已放行，**或改用 `SMTP_PORT=2587`** | 已有 VPS 实测 25/465/587 全部 `ECONNREFUSED`（宿主机直连同样如此）；Resend 的 2587 可通，实测能发信 |
| 7 | `TZ` 与 `NOTIFY_TIMEZONE` 一致（默认都是 `Asia/Shanghai`） | 前者决定「不带时区」的日期怎么解析、后者决定时刻怎么渲染；不一致会差 8 小时且不报错 |

---

## 5. `compose.yaml` 逐段说明

| 段落 | 值 | 为什么这么写 |
|---|---|---|
| `build` / `image` | `.` → `mindwtr-notify:local` | 本地构建、只打本地 tag，不推仓库 |
| `container_name` | `mindwtr-notify` | 固定名字，便于 `logs` / `inspect` |
| `restart` | `unless-stopped` | 宿主机重启后自动拉起 |
| `env_file` | `.env` | 把文件里每条 `KEY=VALUE` **原样注入容器** |
| `environment` | `NOTIFY_STATE_PATH=/app/data/notify.sqlite`、`HEALTHZ_PORT=8788` | 显式键优先级高于 `env_file`，会覆盖 `.env` 里的同名项 |
| `TZ` | `${TZ:-Asia/Shanghai}` | **进程时区**：镜像默认 UTC，会让「不带时区」的日期晚 8 小时解析；写成插值才能被 `.env` 覆盖，详见 [配置参考 §4.2.1](configuration.md) |
| `volumes` | `notify-data:/app/data` | 去重记录持久化，容器重建不丢；**删卷会重发** |
| `read_only` | `true`（EXT-15【官方无】） | 根文件系统只读，进程改不了镜像里的代码 |
| `tmpfs` | `/tmp:size=16m,mode=1777` | Bun 启动与 healthcheck 需要可写临时目录 |
| `ports` | `127.0.0.1:8788:8788` | 只映射回环，管理页与 healthz 不对外暴露 |
| `healthcheck` | `bun -e` 请求 `/healthz` | 30s 间隔 / 5s 超时 / 3 次重试 / 20s 起步；不依赖 alpine 是否装 curl，`HEALTHZ_TOKEN` 非空时自动从环境变量带 Bearer 头 |
| `deploy.replicas` | `1` | 无 leader election，多副本会重复投递 |

镜像侧对应 `Dockerfile`：只 `COPY package.json` 与 `src/`，**不含** `scripts/`
（其中 `seed-test-data.mjs` 能写测试实例）与任何 `.env`；`.dockerignore` 统一排除
`.env` / `scripts/` / `tests/` / `data/` / 联调文件。

---

## 6. 环境变量在 Compose 里的两条通道（最容易踩的坑）

**① 解析期插值**（宿主机上，只作用于 `compose.yaml` 里的 `${VAR}`）

```
shell 环境变量  >  docker compose --env-file <文件>  >  compose 文件所在目录的 .env
```

本项目 `compose.yaml` 里只有**一处** `${}` —— `TZ: ${TZ:-Asia/Shanghai}`（进程时区，见 [配置参考 §4.2.1](configuration.md)）。
其余键一律不写 `${}`，所以 `.env` 主要走通道 ②。
`TZ` 这处插值也会被同目录 `.env` 的值覆盖，而 `environment` 的优先级高于 `env_file` ——
正因如此，它必须写成插值而不能写死 `Asia/Shanghai`，否则在 `.env` 里改时区不会生效。

**② 运行期注入**（容器里真正能看到的值）

- `env_file: - .env` 把**每一行**原样塞进容器环境；
- `environment:` 里显式写的键优先级更高；
- **shell 里的环境变量不会自动进容器**，除非写成 `environment: - KEY`（不带值）或用 `${KEY}` 插值。

由此得到三条实操结论：

1. `.env` 里所有键都会进容器，所以**部署用 `.env` 要最小化**：`SSH_URI` 是本机运维连接串，
   与服务无关，不要放进去；模板里的空值项也可删掉。
2. 改了 `.env` 后，用 `docker compose up -d --force-recreate` 让新值生效（Compose 检测到配置变化通常会自己重建，显式指定更稳）。
3. 想让某个值可被 shell 覆盖，得在 `compose.yaml` 写成 `${HEALTHZ_PORT:-8788}`；
   现在写死 `"8788"`，在 shell 里设 `HEALTHZ_PORT` 是无效的。`TZ` 是唯一已经写成插值的例外。

---

## 7. 数据、卷与「重启不重复投递」

状态库是 `notify-data` 卷里的 `notify.sqlite`（伴随 `-wal` / `-shm`）。
投递成功后每个渠道单独记一条 `sent` 记录，重启时命中去重键就跳过，所以**卷在，去重就在**。

⚠️ **删除卷 = 丢失去重记录 = 历史提醒可能重发**。
`docker compose down`（不带 `-v`）保留卷；`down -v` 会连卷一起删。
升级、重启、改配置都用不带 `-v` 的命令。

卷名会带 Compose 项目名前缀（默认取目录名），先查实际名字再备份：

```bash
docker volume ls --format '{{.Name}}' | grep notify-data
```

---

## 8. 日常运维命令速查

| 目的 | 命令 |
|---|---|
| 查看状态与健康 | `docker compose ps` |
| 看实时日志 | `docker compose logs -f --tail 100 mindwtr-notify` |
| 重启（会立即跑一轮） | `docker compose restart mindwtr-notify` |
| 停止（保留卷） | `docker compose down` |
| 改配置后重建 | `docker compose up -d --force-recreate` |
| 改代码后重建镜像 | `docker compose up -d --build` |
| 安全校验配置 | `docker compose config --quiet` |
| 容器内跑一轮只读计划 | `docker compose exec mindwtr-notify bun run src/cli.ts --dry-run --strict` |
| **临时开 debug 排障** | `docker compose exec mindwtr-notify bun run src/cli.ts --dry-run --strict --log-level=debug` |
| **常驻服务长期开 debug** | 改 `.env` 的 `NOTIFY_LOG_LEVEL=debug` 后 `docker compose up -d --force-recreate` |
| 渠道自检（会真的发） | `docker compose exec mindwtr-notify bun run src/cli.ts --test-email` |
| 查看容器内配置键名 | `docker compose exec mindwtr-notify env \| cut -d= -f1 \| sort` |

> 最后一条只列键名，不打印值；**不要**用 `env` 直接打印全部内容。

---

## 9. 升级 / 回滚 / 备份 / 卸载

**升级**

```bash
# 先给当前镜像留个可回滚的 tag
docker tag mindwtr-notify:local mindwtr-notify:prev
# 同步新源码后
docker compose config --quiet && docker compose up -d --build
docker compose ps && curl -sS http://127.0.0.1:8788/healthz
```

**回滚**（代码与镜像一起回到上一版；状态库卷保留，不会重发）

```bash
docker tag mindwtr-notify:prev mindwtr-notify:local
docker compose up -d --force-recreate
```

**备份状态库卷**

```bash
VOLUME=$(docker volume ls --format '{{.Name}}' | grep notify-data | head -1)
docker compose down          # 先停，保证 SQLite WAL 已落盘
docker run --rm -v "$VOLUME:/data:ro" -v "$PWD:/backup" alpine:3.20 \
  tar czf /backup/notify-data.tgz -C /data .
docker compose up -d
```

**恢复**

```bash
VOLUME=$(docker volume ls --format '{{.Name}}' | grep notify-data | head -1)
docker compose down
docker run --rm -v "$VOLUME:/data" -v "$PWD:/backup" alpine:3.20 \
  tar xzf /backup/notify-data.tgz -C /data
docker compose up -d
```

**卸载**：`docker compose down`（保留卷，便于日后重建）；
确认不再需要且能接受去重记录丢失时，才用 `docker compose down -v`。

---

## 10. 健康检查与故障排查

| 症状 | 先查什么 | 常见原因 / 处理 |
|---|---|---|
| `ps` 一直 `health: starting` 或 `unhealthy` | `docker compose logs --tail 50`、`docker inspect <容器> --format '{{json .State.Health.Log}}'` | 服务没起来 / `HEALTHZ_TOKEN` 配了但 healthcheck 没读到；healthcheck 会自动带 token，正常应 `healthy` |
| `/healthz` 返回 401 | `.env` 的 `HEALTHZ_TOKEN` | 非空即需鉴权：`curl -H 'Authorization: Bearer <token>' ...`；healthcheck 不受影响 |
| 日志「计划 0 条」 | 云端任务是否带时间字段 | 生产数据若全无 `dueDate` / `startTime`，任务级提醒本就为 0；摘要类仍会按时刻触发，属正常 |
| 「0 条任务 + fetch failed」 | `curl <cloud>/health`、网络 / 代理 | VPS 上通常是网络或 DNS；本机开发期是代理端口问题（见 §2） |
| 邮件投递失败 `ECONNREFUSED` | 宿主机 `nc -vz <smtp-host> 587`，再试 `2587` | VPS 出站被拦（25/465/587 被 RST）。**Resend 把 `SMTP_PORT` 改成 `2587`（STARTTLS）即可发信，无需改代码**；`2465` 是隐式 TLS，当前代码不支持。详见 [配置参考 §4.6](configuration.md) |
| Webhook 全部失败 | 接收端是否校验 `X-Notify-Signature` | 见 [配置参考 §5](configuration.md)；URL / 密钥不匹配或时间戳超出 5 分钟 |
| **日志显示成功但群里没消息** | `node src/cli.ts --test-webhook --log-level=debug` | 企微 / 钉钉 / 飞书可能回 `200 + errcode!=0`；v1.15 起会判为业务失败并写明错误码。同时确认 `NOTIFY_WEBHOOK_ADAPTERS` 与 URL 一一对应（漏配会退化成 `generic` 结构化 JSON），详见 [输出格式清单 §10](webhook-payload.md) |
| 日志太少 / 想看每次 Cloud 请求 | `.env` 的 `NOTIFY_LOG_LEVEL`，或临时加 `--log-level=debug` | 默认 `info` 只打每轮汇总；debug 会显示路径、状态、耗时、计划与逐条触发点决策，详见 [配置参考 §9](configuration.md) |
| 提醒比预期**晚 / 早 8 小时** | 容器内 `bun -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"` | 进程时区是 UTC：`compose.yaml` 已默认 `TZ: ${TZ:-Asia/Shanghai}`，检查 `.env` 里是否覆盖成别的值（或写法带了注释），改完 `--force-recreate`。详见 [配置参考 §4.2.1](configuration.md) |
| 收到重复提醒 | `docker compose ps`、卷是否被删过 | 是否起了两个副本、两套 Compose 共用一个卷、或执行过 `down -v` |
| 管理页数据空白 / 401 | 页面右上角令牌输入框 | 填 `NOTIFY_ADMIN_TOKEN`（或 `HEALTHZ_TOKEN`）后点「刷新」，见 [操作手册](admin-guide.md) |

---

## 11. 安全边界（改配置时不要削弱）

1. 凭据只放本机 `.env`（权限 600、已被 `.gitignore` 排除）；不进日志、文档、聊天、镜像或构建上下文。
2. 由于 `env_file` 全量注入，部署 `.env` 只写服务需要的键。
3. 只映射 `127.0.0.1`；远程看管理页用 SSH 端口转发（见操作手册 §1），**不要**改成 `0.0.0.0`。
4. `read_only: true` + `tmpfs /tmp` 保持开启；唯一可写位置是卷 `/app/data`。
5. `replicas: 1` 恒定；产品代码对生产实例只读 GET 白名单，`/complete` 等写端点默认永不触发。
6. 校验配置只用 `config --quiet`。

---

## 12. 不用 Docker 时（本机开发 / 排障）

本机 Node 22 可直接跑 TypeScript，无需编译、零依赖：

```bash
npm test                              # 85 个用例，纯本地
npm run dry-run                       # 只读跑一轮 strict 计划，不投递不写库
node src/cli.ts --dry-run --strict --log-level=debug   # 同上，但打印完整诊断链路
npm run once                          # 跑一轮并真实投递
npm start                             # 常驻 + /healthz + /admin
NOTIFY_LOG_LEVEL=debug npm start      # 常驻 + debug 日志（也可用 --log-level=debug）
node src/cli.ts --help                # 全部 CLI 开关
node src/cli.ts --test-email          # 无 SMTP 时落盘 data/test-emails.txt
node src/cli.ts --test-webhook        # 向第一个 Webhook URL 发测试消息
```

| CLI 开关 | 作用 |
|---|---|
| `--once` | 跑一轮后退出 |
| `--dry-run` | 只打印计划，不投递、不写状态库（隐含 `--once`） |
| `--strict` | 强制关闭全部 A 类扩展，用于与官方规则做一致性比对 |
| `--test-email` / `--test-webhook` | 渠道自检，会真实发送 |

> `NOTIFY_STATE_PATH` 默认是相对路径 `data/notify.sqlite`；Compose 里被 `environment` 覆盖成卷内绝对路径，
> 所以同一套代码在本机与容器里各自有独立状态库，互不干扰。
