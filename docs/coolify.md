# 在 Coolify 上部署 Notify

> 对应 `spec.md` **v1.21** · 已在 **Coolify 4.7.5 / Traefik v3.7** 环境核对（2026-11-15）
> 代码已在公有仓库 `https://github.com/zlay0701/mindwtr-notify`（main），可直接部署。
> 本文只讲 Coolify。原生 `docker compose` 见 [部署指南](deployment.md)，配置项含义见
> [配置参考](configuration.md)，管理页用法见 [页面操作手册](admin-guide.md)，
> 云端接口见 [Cloud API 调用清单](cloud-api.md)，出站消息格式见 [Webhook 输出格式](webhook-payload.md)。
>
> ⚠️ 本文是**部署教程**：代码已就绪，但**尚未在你的 Coolify 上创建资源或发起部署**，
> 也没有向任何渠道发消息。第一次 Deploy 需要你在面板里点。

---

## 0. 三步快速路径（代码已在 GitHub，照这个点就行）

1. **Project → Environment → `+ New` → `Public Repository`**，填
   `https://github.com/zlay0701/mindwtr-notify`，Build Pack 选 **Docker Compose**。
2. **Configuration → General**：Base Directory `/`，Docker Compose Location `/compose.coolify.yaml`。
3. **Environment Variables**（Developer View）粘 §4 步骤 3 的清单，把 `MINDWTR_TOKEN` 与
   `WEBHOOK_URLS` 换成真实值 → **Deploy**。

配好后**不要配域名**（服务纯出站）；出问题先看 §7 常见坑。每一步的细节与「为什么」在 §1–§6。

---

## 1. 先想清楚：这是一个「纯出站」服务

Notify 不接收入站业务请求，它只做两件事：定时 `GET` 拉取 Mindwtr Cloud，算出触发点，
再 `POST` 到你的邮件 / Webhook。`/healthz` 和 `/admin` 只是**可选**的本地管理接口。

这条性质决定了 Coolify 上的三个默认值，和一般 Web 应用不一样：

| 一般 Web 应用 | Notify |
|---|---|
| 必须配域名、让 Traefik 反代 | **默认不配任何域名**，只让它在内部网络跑 |
| 需要 `ports` 暴露容器端口 | **不发布宿主端口**，Coolify 直接走自己的网络做健康检查 |
| 可以多副本、开 PR 预览 | **只能一个副本**，且要关掉预览部署（否则会重复发提醒） |

只有在你确实需要**远程访问管理页**时才配域名 + HTTPS + 鉴权，见 §5。

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Coolify | v4（本文按 4.7.5 的界面写；不同小版本菜单名可能略有差异） |
| 代码来源 | 公有仓库 `https://github.com/zlay0701/mindwtr-notify.git`（或你自己的 fork），Coolify 能 clone |
| 构建 | 目标服务器装好 Docker + Compose（Coolify 自带），**本机不需要 Docker / Bun** |
| 凭据 | `MINDWTR_TOKEN`（FULL token，capture-only token 会 403）、至少一个投递渠道 |
| 网络 | 服务器能出站访问 `MINDWTR_BASE_URL`、SMTP / Webhook 地址 |
| 仓库安全 | `.env` **绝不提交**；项目 `.gitignore` 已忽略 `.env` / `.env.*` |

### 2.1 代码来源：已就绪，无需再建仓库

代码已在**公有仓库** `https://github.com/zlay0701/mindwtr-notify`（main，54 个文件），
Coolify 直接 clone 即可 —— 公有仓库**不需要 Deploy Key 或 GitHub App**。

如果你要改代码并让 Coolify 跟着更新，fork 一份或用自己的私有仓库，那时才需要配
Deploy Key / GitHub App，并把 §4 步骤 1 的仓库地址换成你自己的。

> 仓库里**没有** `.env`（`.gitignore` 已忽略），所以部署时按 §4 步骤 3 在面板里填变量。
> `scripts/` 里的探针与造数脚本虽然进了仓库，但被 `.dockerignore` 排除，**不会进生产镜像**。

### 2.2 一个很容易踩的坑：别整份复制 `.env.example`

`.env.example` 里有不少**行尾注释**。项目的 `.env` 解析器（以及 Coolify 的 Developer View）
不会去掉行尾注释，`NOTIFY_LOG_LEVEL=info  # 说明` 会把整串当成值读进去。
所以**不要把 `.env.example` 整份粘进 Coolify**，用 §4 那份干净清单。

---

## 3. 为什么单独有一份 `compose.coolify.yaml`

仓库根目录的 `compose.yaml` 是给「VPS 上原生 `docker compose up`」用的，直接拿去 Coolify
会有三处不适配。项目因此提供一份 Coolify 专用编排，两者差异如下：

| 项 | `compose.yaml`（原生） | `compose.coolify.yaml`（本教程） | 原因 |
|---|---|---|---|
| 配置注入 | `env_file: - .env` | `environment:` + `${VAR}` 白名单 | Coolify 的凭据只应存在面板里；`env_file` 还会把 `SSH_URI` 这类本机运维变量带进容器 |
| 容器名 | `container_name: mindwtr-notify` | 不写 | Coolify 自行加前缀 / 重命名，写死会冲突 |
| 端口 | `127.0.0.1:8788:8788` | 不发布端口 | 官方明确不建议在 Compose 里 `ports:`；发布宿主端口会绕过域名代理路由 |
| 域名 | 无 | 可选用 Coolify Domains（带 `:8788`） | 需要远程管理页时才开，见 §5 |
| 其余 | — | **完全一致** | `read_only: true` + `tmpfs /tmp`、命名卷、`healthcheck`、`replicas: 1` 全部保留 |

另外 `compose.coolify.yaml` **故意没有**注入 `NOTIFY_ALLOW_WRITE` / `NOTIFY_COMPLETE_ACTION`：
这两道开关控制对云端写端点，硬约束要求对生产实例只能发 `GET`。不注入，代码就用内置 `false`，
面板里也无法误开。`NOTIFY_STATE_PATH` / `HEALTHZ_PORT` 也写死，避免状态库被改到只读根文件系统上。

> 该文件只给 Coolify 用。本机跑 `docker compose -f compose.coolify.yaml config` 会因 `${...}`
> 未设置而报错，属正常；已在远端用真实 Docker Compose 验证过语法与插值（缺 token 时 `:?`
> 会阻止部署，注入后退出 0）。

---

## 4. 六步部署

### 步骤 1 · 创建资源（选对类型）

在 Coolify：**Project → Environment → `+ New` → `Public Repository`**，填
`https://github.com/zlay0701/mindwtr-notify`，点 **Check Repository** 确认能读到仓库。

- **Build Pack 选 `Docker Compose`**
- 必须走 **Git 仓库** 这条路：项目用 `build: .`，需要仓库里的 `Dockerfile`、`package.json`、`src/`
  作为构建上下文。**「Docker Compose Empty」没有源码上下文**，除非你先把镜像推到 registry
  并把编排改成 `image:`，否则不要用。
- 不要启用 **Raw Compose Deployment**：那会让 Coolify 不补代理标签与网络，得自己全写。

### 步骤 2 · 指向专用编排文件

在 **Configuration → General** 设置（不同版本名称可能是 "Compose File" / "Custom Compose File"）：

| 字段 | 值 |
|---|---|
| Base Directory | 仓库根（`/`，即 `Dockerfile` 与 `compose.coolify.yaml` 所在目录） |
| Docker Compose Location | `/compose.coolify.yaml`（相对 Base Directory 的路径） |

保存后 Coolify 会解析并展示渲染后的 Compose 内容。**Git 源的项目要以仓库里的文件为准**，
不要在面板里手改渲染结果——下次部署会被仓库文件覆盖。

### 步骤 3 · 填环境变量（凭据只放这里）

进 **Configuration → Environment Variables**，用 **Developer View** 粘贴下面这份干净清单。
`${VAR}` 会由 Coolify 自动生成可编辑变量；留空时代码走内置默认值。

```dotenv
MINDWTR_BASE_URL=https://mindwtr-cloud.zlay.dpdns.org
MINDWTR_TOKEN=<你的 FULL bearer token>
TZ=Asia/Shanghai
NOTIFY_TIMEZONE=Asia/Shanghai
NOTIFY_LOG_LEVEL=info
WEBHOOK_ENABLED=true
WEBHOOK_URLS=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<你的机器人 key>
NOTIFY_WEBHOOK_ADAPTERS=wecom
WEBHOOK_SECRET=
NOTIFY_WEBHOOK_SECRETS=
WEBHOOK_MAX_ATTEMPTS=3
SMTP_ENABLED=false
HEALTHZ_TOKEN=<一个随机长字符串>
NOTIFY_ADMIN_TOKEN=<同上或另设一个>
NOTIFY_ADMIN_RETRY=false
```

要点：

- **`MINDWTR_TOKEN` 是唯一必填项**：编排里写成 `${MINDWTR_TOKEN:?}`，为空时 Coolify 会阻止部署。
- `MINDWTR_BASE_URL` 默认已是**生产地址**。开发期本机 `.env` 常指向测试服务器，
  **部署时务必确认这里没有误填测试地址**，否则提醒内容会来自测试库。
- **`TZ` 与 `NOTIFY_TIMEZONE` 一起填**：容器默认是 UTC，`TZ` 决定「不带时区」的日期怎么解析，
  缺了会让提醒晚 8 小时、且不报错（编排里已预填 `Asia/Shanghai`，见 [配置参考 §4.2.1](configuration.md)）。
- `NOTIFY_WEBHOOK_ADAPTERS=wecom` 是关键：漏配会静默退化成 `generic`，把结构化 JSON 发给企微。
- `WEBHOOK_SECRET=` / `NOTIFY_WEBHOOK_SECRETS=` **就留空**（企微无签名）。
  不要写 `# 留空即可` 之类的行尾注释，注释必须独占一行。
- `HEALTHZ_TOKEN` 建议设：compose 的 healthcheck 会自动带上它，
  所以开启鉴权不会让容器变 `unhealthy`（v1.10 已端到端验证）。
- 其它配置（摘要开关、A 类扩展、标签路由、可靠性参数）不用现在填，
  `compose.coolify.yaml` 已经列好引用，之后想调直接在面板里加值即可。

**凭据不要勾 Build Variable**：Coolify 对 Git Compose 应用可能把构建期变量作为 `--build-arg`
注入，会留在镜像元数据里。本项目 Dockerfile 不声明任何 `ARG`，
若界面里有 **Advanced → Inject Build Args to Dockerfile** 之类的开关，建议关闭。
Coolify 默认也会对部署日志中的环境变量值做脱敏，但仍不要把 token 贴进备注 / 支持工单。

### 步骤 4 · 域名（默认跳过）

**默认不配域名**，服务不需要入站流量，直接在内部网络跑最安全。

只有需要远程看 `/admin` 管理页时才配：在组件的 **Domains** 里填
`https://notify.example.com:8788`（尾部 `:8788` 是**容器内部端口**，告诉 Coolify 代理往哪转发；
公网请求仍是正常 443）。此时必须同时满足：

1. `HEALTHZ_TOKEN` 与 `NOTIFY_ADMIN_TOKEN` 都已设置（管理页与 `/healthz` 共用鉴权）；
2. 强制 HTTPS（Coolify 自动签证书）；
3. 清楚 `/healthz` 与 `/admin` 都会暴露到公网；`NOTIFY_ADMIN_RETRY` 保持 `false`。

> 不配域名时，`/healthz` 与 `/admin` **只在容器网络内可达**（Coolify 版没发布宿主端口）。
> 临时排障可在宿主机先查容器 IP，再转发到本机：
> `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <容器名>`，
> 然后 `ssh -L 8788:<容器IP>:8788 <服务器>`，本机访问 `http://127.0.0.1:8788/admin`。
> 容器重建后 IP 会变；想长期稳定访问，还是配一个带强 token 的域名更省事。

### 步骤 5 · 确认卷、副本与预览部署

- **持久化卷**：编排里是 `notify-data:/app/data`，Coolify 会给 managed volume **加前缀**，
  实际名字在 **Configuration → Persistent Storages** 里看（那个页面对 Compose 拥有的卷是只读的，
  要改挂载得改仓库里的编排文件）。状态库存去重记录，**丢了就会重复投递**。
- **副本数固定 1**：编排里 `deploy.replicas: 1`。不要在 Coolify 里横向扩容，
  也不要让第二个资源指向同一个卷 —— 没有 leader election，两个实例会各发一遍。
- **关掉 PR / Preview Deployments**：预览环境会独立跑一份完整服务并连同一套渠道，
  等于多一个实例重复发提醒。
- `read_only: true` 下只有 `/app/data` 和 `tmpfs /tmp` 可写，`NOTIFY_STATE_PATH` 已被写死在卷上。

### 步骤 6 · Deploy 并验证

点 **Deploy**，在 **Deployments** 看构建日志；完成后分两个层面验证。
注意 Coolify 版**没有发布宿主端口**，所以宿主机上 `curl 127.0.0.1:8788` 是不通的，
探活要在容器内做。

```bash
# A. SSH 到 Coolify 宿主机：这里才能用 docker 命令
docker ps --format '{{.Names}} | {{.Status}}' | grep -i notify   # 应 running / healthy
docker inspect <容器名> --format '{{.State.Health.Status}} {{.HostConfig.ReadonlyRootfs}}'

# B. 进容器（Coolify 的 Terminal 就是容器内 shell；也可用 docker exec）
#    全部只读、不发提醒
bun run src/cli.ts --dry-run --strict --log-level=debug
bun -e "fetch('http://127.0.0.1:8788/healthz',{headers:{Authorization:'Bearer <HEALTHZ_TOKEN>'}}).then(r=>console.log('HTTP='+r.status)).catch(e=>console.log('ERR='+e.message))"
```

> 若用 `docker exec`，写 `docker exec <容器名> bun run src/cli.ts --dry-run --strict`；
> 容器名带 Coolify 前缀，先按上面 A 的 `docker ps` 拿到再填。
> 不要依赖 `docker compose exec`：Coolify 用的是自定义编排文件名与项目名。

`--dry-run` 会打印每轮拉取的任务数、计划条数与 debug 链路，是最安全的验收方式。
需要确认渠道真的能发时再用 `--test-webhook`：

```bash
bun run src/cli.ts --test-webhook --log-level=debug
```

> ⚠️ 这条会**真的往你的企业微信群发一条测试消息**，请自己决定何时执行。
> 正常输出：`Webhook 测试成功（适配器 wecom，第 1 次尝试）。`
> 若返回 `Webhook 业务失败：errcode=...`，按 [输出格式清单 §10](webhook-payload.md) 排查。

---

## 5. 域名、鉴权与「纯出站」的取舍

| 场景 | 建议 |
|---|---|
| 只想让服务稳定跑、发提醒 | **不配域名**（推荐）。Coolify 仍能构建、重启、看日志、做健康检查 |
| 偶尔要看管理页 | 按容器 IP 做 SSH 转发（临时），或配一个带强 token 的域名 |
| 长期公网管理页 | 配 `https://...:8788` + `HEALTHZ_TOKEN` + `NOTIFY_ADMIN_TOKEN` + 保持 `NOTIFY_ADMIN_RETRY=false` |

管理页字段、手动重发语义与 API 速查见 [页面操作手册](admin-guide.md)。

---

## 6. 升级 / 回滚 / 备份 / 卸载

| 动作 | 做法 |
|---|---|
| 升级 | push 到仓库 → Coolify **Redeploy**（或配置自动部署 webhook）。容器重建，**卷保留**，去重记录不丢 |
| 只改配置 | 在 Environment Variables 改值 → **Restart / Redeploy**，让 Coolify 重写 `.env` 并重建容器；光 `restart` 不加载新变量 |
| 回滚 | 在 Deployments 里选上一个成功 commit 重新部署；或 `git revert` 后 push |
| 备份 | 备份 **Persistent Storages 里显示的真实卷名**下的 `notify.sqlite / -wal / -shm`；注意 Coolify 加了前缀 |
| 卸载 | 删除资源时**不要勾选删除持久化数据 / 卷**（否则丢去重记录，重建后会重复投递） |
| 不要用 | `docker compose down -v`、裸 `docker compose config`（会展开明文）、Raw Compose Deployment |

---

## 7. 常见坑对照表

| 现象 | 原因 / 处理 |
|---|---|
| 部署被阻止、提示 required variable | `${MINDWTR_TOKEN:?}` 生效：去 Environment Variables 填 FULL token |
| 构建成功但容器 `unhealthy` | 看容器日志；`HEALTHZ_TOKEN` 配了但 healthcheck 应会自动带 token（已验证）。确认 `/app/data` 可写、`tmpfs /tmp` 存在 |
| 用「Docker Compose Empty」后构建失败 | 本项目 `build: .` 需要 Git 源码上下文，改走 Git 仓库 + Compose Build Pack，或改用预构建 `image:` |
| 提醒内容来自测试库 | `MINDWTR_BASE_URL` 误填测试地址；改回生产地址并 Redeploy |
| 提醒时间差 8 小时 | 容器进程时区是 UTC：面板里把 `TZ` 设成 `Asia/Shanghai`（与 `NOTIFY_TIMEZONE` 一致），然后 Redeploy；见 [配置参考 §4.2.1](configuration.md) |
| 企微收不到消息，但日志说成功 | 检查 `NOTIFY_WEBHOOK_ADAPTERS`；v1.15 起 `200 + errcode!=0` 会判为业务失败，看具体 `errcode`，见 [webhook-payload.md §10](webhook-payload.md) |
| 邮件渠道全失败 | 部分 VPS 出站 25/465/587 被拒（本项目已在目标 VPS 实测）；**把 `SMTP_PORT` 改成 `2587`（STARTTLS）即可发信**，不用改代码；`2465` 是隐式 TLS，当前代码不支持 |
| 收到重复提醒 | 是否开了预览部署、扩了副本、或删过卷；`docker compose ps` 看实例数 |
| 管理页 401 | 右上角令牌输入框填 `NOTIFY_ADMIN_TOKEN`（或 `HEALTHZ_TOKEN`）后刷新 |
| 配置改了不生效 | 只改环境变量必须重建容器；`restart` 不会重新读 `.env`。改编排文件要改**仓库里的文件**再部署 |
| 构建日志出现 unused build arg 警告 | 关闭 `Inject Build Args to Dockerfile` 之类开关；本镜像不需要任何 ARG |
| 卷名找不到 | Coolify 会给 managed volume 加前缀，去 Persistent Storages 看真实名字 |
| `.env` 被提交进仓库 | 立刻轮换 token 并清理历史；`.gitignore` 已忽略 `.env`，部署变量应只在 Coolify 面板里 |

---

## 8. 安全边界（改配置时不要削弱）

1. **对生产 Cloud 只读**：只允许白名单内的 `GET`，产品运行时实际只发 `GET /v1/tasks` 与
   `GET /v1/projects`，见 [cloud-api.md](cloud-api.md)。`NOTIFY_ALLOW_WRITE` /
   `NOTIFY_COMPLETE_ACTION` 故意没进 Coolify 编排，不要自行加回去。
2. **凭据只在 Coolify 面板**：`.env` 不进仓库、不进镜像（`.dockerignore` 已排除），
   不贴聊天 / 工单 / 日志。企微 Webhook URL 里的 `key` 等同密码。
3. **单实例**：无 leader election，多副本或预览环境会重复投递。
4. **卷不能删**：状态库存去重键，删了会重发；升级 / 卸载都保留卷。
5. **日志脱敏**：v1.13 起运行时日志走 `src/logger.ts`，URL 统一替换成 `[url]`；
   `--dry-run` 与 `--test-*` 的「命令输出」不受日志级别过滤，排障时仍可见。
6. **管理页默认只读**：手动重发需 `NOTIFY_ADMIN_RETRY=true` + 有效 token，默认关闭。

---

## 9. 与原生 Compose 部署的速查

| 想做的事 | 原生 `docker compose`（[deployment.md](deployment.md)） | Coolify（本文） |
|---|---|---|
| 编排文件 | `compose.yaml` | `compose.coolify.yaml` |
| 配置来源 | 服务器上 `.env` + `env_file` | Coolify Environment Variables + `${VAR}` |
| 校验 | `docker compose config --quiet` | 面板解析 + Deployments 日志 |
| 启动 | `docker compose up -d --build` | Deploy |
| 健康检查 | 容器内 `/healthz` | 同（Compose 拥有健康检查，Coolify 不用自己的页面） |
| 访问管理页 | `127.0.0.1:8788` | 默认不可公网访问；可选域名 `:8788` |
| 卷 | `notify-data` | 加前缀的真实卷名，见 Persistent Storages |
| 单实例 | `replicas: 1` | 同，且要关预览部署 |

> 需要「首次上线 runbook」或把这份教程合进 PDF / Word 手册，另说一声。
