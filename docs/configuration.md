# Notify 配置参考

> 对应 `spec.md` **v1.18**。模板在仓库根目录 `.env.example`；部署方式见 [部署指南](deployment.md) 与 [Coolify 教程](coolify.md)，  
> 管理页用法见 [页面操作手册](admin-guide.md)，调用哪些云端接口见 [Cloud API 调用清单](cloud-api.md)，  
> 出站 POST 的完整数据格式见 [Webhook 输出数据格式清单](webhook-payload.md)。  
> 本文所有示例都用占位符，**不含任何真实凭据**。



---

## 1. 配置从哪里来（优先级从高到低）

| 优先级 | 来源                                                 | 说明                                     |
| --- | -------------------------------------------------- | -------------------------------------- |
| 1   | CLI 显式覆盖                                           | `--strict` 会强制关闭全部 A 类扩展               |
| 2   | 进程环境变量 / Compose `environment:`                    | 容器内由 Compose 注入；shell 变量不会自动进容器        |
| 3   | `NOTIFY_CONFIG` 指向的 JSON 里 `namespaces.<当前命名空间>` 段 | 只作用于该命名空间，键名与 `.env` 相同                |
| 4   | 项目根目录 `.env`                                       | 由程序自己读取；Compose 另外通过 `env_file` 把它注入容器 |
| 5   | 代码默认值                                              | 见下表                                    |

`NOTIFY_NAMESPACE` 必须最先确定：它决定读哪一段配置、状态库落在哪个文件、去重键是否加前缀。  
默认值 `default` 与旧版本完全兼容；非默认命名空间会自动派生 `data/notify-<ns>.sqlite`。

> Compose 下 `compose.yaml` 的 `environment:` 显式写了 `NOTIFY_STATE_PATH=/app/data/notify.sqlite`  
> 与 `HEALTHZ_PORT=8788`，这两项会**覆盖** `.env` 里的同名值。其余键来自 `env_file: - .env`，原样注入。

---

## 2. 必填项与启动校验

**唯一必填：`MINDWTR_TOKEN`**，且必须是**完整 bearer token**。  
capture-only token 只能调 `POST /v1/capture`，在 `/v1/tasks`、`/v1/projects` 会返回 403。

服务启动前会跑 `validateConfig`，以下任一命中就拒绝启动（错误打印在 stderr）：

| # | 校验规则                                                                 |
| - | -------------------------------------------------------------------- |
| 1 | 缺少 `MINDWTR_TOKEN`                                                   |
| 2 | `MINDWTR_BASE_URL` 不是合法 `http(s)://` 地址                              |
| 3 | `NOTIFY_POLL_SECONDS < 15`（避免给 Cloud API 造成压力）                       |
| 4 | `SMTP_ENABLED=true` 但缺 `SMTP_HOST` 或 `SMTP_TO`                       |
| 5 | `WEBHOOK_ENABLED=true` 但缺 `WEBHOOK_URLS`                             |
| 6 | `NOTIFY_ADMIN_RETRY=true` 但没配 `NOTIFY_ADMIN_TOKEN` / `HEALTHZ_TOKEN` |

渠道全关**不算错误**：服务仍会计划、记录，只是不向外投递，`--dry-run` 也能正常跑。

---

## 3. 三态标记怎么读

| 标记    | 含义                                           |
| ----- | -------------------------------------------- |
| 【一致】  | 官方文档 / 源码已有，逐字复刻（`BASE-01…29`），**不可关闭、不可改动** |
| 【增强】  | 官方有同一机制，扩展了实现、范围或可靠性，不新增触发点                  |
| 【官方无】 | 官方文档与源码均不存在，属本项目自加能力                         |

新增触发点类扩展（A 类）**默认全部关闭**，`NOTIFY_STRICT=true` 或 CLI `--strict` 可一键回到 100% 一致。

---

## 4. 配置项总表

布尔值接受 `true` / `1` / `yes`（不分大小写），其他值按 `false` 处理；  
列表类用英文逗号分隔；数字非法时回退到默认值。

### 4.1 Cloud 连接

| 键                  | 默认值                                    | 说明                          | 标记 |
| ------------------ | -------------------------------------- | --------------------------- | -- |
| `MINDWTR_BASE_URL` | `https://mindwtr-cloud.zlay.dpdns.org` | 生产实例地址；末尾斜杠会被去掉。开发期可切测试实例   | —  |
| `MINDWTR_TOKEN`    | 空（**必填**）                              | 完整 bearer token，只放本机 `.env` | —  |

### 4.2 全局与调度

| 键                     | 默认值                  | 说明                                                                                      | 标记               |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `NOTIFY_TIMEZONE`     | `Asia/Shanghai`      | 摘要时刻、静默时段按此时区判定                                                                         | —（时区渲染见 BASE-23） |
| `NOTIFY_STRICT`       | `false`              | `true` 强制关闭全部 A 类扩展，用于一致性验收                                                             | 【官方无】验收机制        |
| `NOTIFY_POLL_SECONDS` | `60`                 | 轮询间隔（秒），官方桌面端 15s；设 15 可完全对齐，不得低于 15                                                    | EXT-08【增强】       |
| `NOTIFY_GRACE_MS`     | `300000`             | 补发窗口 5 分钟，对齐官方 `MAX_CATCH_UP_MS`（BASE-27）                                               | 【一致】             |
| `NOTIFY_CATCH_UP`     | `true`               | `false` 时过去时刻的触发点一律不补发                                                                  | 【一致】             |
| `NOTIFY_STATE_PATH`   | `data/notify.sqlite` | 状态库路径；Compose 里被覆盖为 `/app/data/notify.sqlite`                                           | EXT-06【增强】       |
| `HEALTHZ_PORT`        | `8788`               | `/healthz` 与 `/admin` 共用端口                                                              | EXT-12【官方无】      |
| `HEALTHZ_TOKEN`       | 空                    | 非空时 `/healthz` 需要 Bearer 鉴权；healthcheck 会自动带上它                                          | EXT-12【官方无】      |
| `NOTIFY_LOG_LEVEL`    | `info`               | 运行时日志级别：`debug` / `info` / `warn` / `error` / `silent`；可用 CLI `--log-level=` 临时覆盖，详见 §9 | EXT-20【官方无】      |

### 4.3 与官方一致的任务 / 摘要设置

任务级提前量、重复间隔、发送策略**不在这里配**，直接读取任务字段  
（`dueReminderLeadMinutes` / `startReminderLeadMinutes` / `repeatReminderMinutes` / `reminderPolicy`）。

| 键                                   | 默认值     | 说明                              | 标记          |
| ----------------------------------- | ------- | ------------------------------- | ----------- |
| `NOTIFY_TASK_REMINDER_DEFAULT`      | `send`  | 任务没写策略时的全局默认，可选 `send` / `skip` | BASE-17【一致】 |
| `NOTIFY_INCLUDE_START`              | `true`  | 是否排「开始」提醒                       | BASE-20【一致】 |
| `NOTIFY_INCLUDE_DUE`                | `true`  | 是否排「到期」提醒                       | BASE-20【一致】 |
| `NOTIFY_INCLUDE_REVIEW`             | `true`  | 是否排「回顾」提醒                       | BASE-20【一致】 |
| `NOTIFY_INCLUDE_REFERENCE`          | `false` | 是否排引用提醒                         | BASE-20【一致】 |
| `NOTIFY_DIGEST_MORNING`             | `true`  | 晨间摘要（09:00）                     | BASE-08【一致】 |
| `NOTIFY_DIGEST_EVENING`             | `true`  | 晚间摘要（20:00）                     | BASE-09【一致】 |
| `NOTIFY_DIGEST_WEEKLY`              | `true`  | 周摘要（周日 18:00）                   | BASE-10【一致】 |
| `NOTIFY_DIGEST_WITHOUT_DESCRIPTION` | `true`  | 摘要消息不含任务描述，减小外发内容               | EXT-03【官方无】 |

> 摘要用「触发窗口 + 按天去重」而不是「当前分钟 == 配置分钟」，避免 60 秒轮询错过整分钟。

### 4.4 A 类扩展（默认全部关闭，开启会改变触发计划）

| 键                    | 默认值     | 说明                          | 标记          |
| -------------------- | ------- | --------------------------- | ----------- |
| `NOTIFY_DATE_ONLY`   | `false` | 仅日期任务当日 09:00 汇总            | EXT-16【官方无】 |
| `NOTIFY_BACKLOG`     | `false` | 启动时的积压逾期清单（24h 节流）          | EXT-17【官方无】 |
| `NOTIFY_QUIET_HOURS` | `false` | 静默时段 23:00–08:00 顺延，解禁不叠加补发 | EXT-18【官方无】 |

### 4.5 可靠性

| 键                            | 默认值      | 说明         | 标记          |
| ---------------------------- | -------- | ---------- | ----------- |
| `NOTIFY_FAILURE_ALERT_AFTER` | `3`      | 连续失败几次后发告警 | EXT-11【官方无】 |
| `NOTIFY_MAX_BACKOFF_MS`      | `600000` | 最长退避 10 分钟 | EXT-11【官方无】 |

### 4.6 邮件通道

| 键                         | 默认值      | 说明                                       | 标记         |
| ------------------------- | -------- | ---------------------------------------- | ---------- |
| `SMTP_ENABLED`            | `false`  | 总开关                                      | EXT-01【增强】 |
| `SMTP_HOST`               | 空        | SMTP 服务器地址                               | EXT-01     |
| `SMTP_PORT`               | `587`    | `587` = STARTTLS；`465` = 隐式 TLS（按端口自动判断） | EXT-01     |
| `SMTP_REQUIRE_TLS`        | `true`   | 是否要求 TLS                                 | EXT-01     |
| `SMTP_USER` / `SMTP_PASS` | 空        | 认证账号与密码，绝不写进日志或文档                        | EXT-01     |
| `SMTP_FROM`               | 空        | 发件地址                                     | EXT-01     |
| `SMTP_FROM_NAME`          | `Notify` | 发件人显示名                                   | EXT-01     |
| `SMTP_TO`                 | 空        | 收件人，多个用英文逗号分隔                            | EXT-01     |

> 未配 SMTP 时 `node src/cli.ts --test-email` 会把测试邮件写到 `data/test-emails.txt`，不会外发。

### 4.7 Webhook 通道

| 键                      | 默认值     | 说明                                     | 标记             |
| ---------------------- | ------- | -------------------------------------- | -------------- |
| `WEBHOOK_ENABLED`      | `false` | 总开关                                    | EXT-04/05【官方无】 |
| `WEBHOOK_URLS`         | 空       | 多个 URL 用英文逗号分隔，与适配器一一对应                | EXT-05         |
| `WEBHOOK_SECRET`       | 空       | HMAC-SHA256 密钥，用于 `X-Notify-Signature` | EXT-04         |
| `WEBHOOK_MAX_ATTEMPTS` | `3`     | **一次投递内**最多发几次 HTTP POST（指数退避 200/400/800ms…）；业务码失败不即时重试，见 §4.7.1 | EXT-05         |

> URL 常带密钥，渠道名固定用 `email` / `webhook:0` 这类短名，**不会把 URL 写进状态库**。  
> 完整出站数据格式见 [Webhook 输出数据格式清单](webhook-payload.md)；
> 「200 但 `errcode!=0`」的业务响应校验见该文档 §10。

#### 4.7.1 三层「重试」别混为一谈

| 层次 | 谁控制 | 行为 |
|---|---|---|
| ① 一次投递内的 HTTP 尝试 | `WEBHOOK_MAX_ATTEMPTS`（默认 3） | 仅非 2xx / 网络异常 / 单次 10s 超时才重试，间隔 200/400/800ms…；每次重发**同一份** body，签名不变 |
| ② 业务码失败（v1.15 起） | 代码固定策略 | 2xx 但 `errcode!=0`（无效 key、非法消息格式等）是确定性错误，**立即失败、不即时重试**，避免刷群；状态库记 `failed`，由 ③ 兜底 |
| ③ 跨轮重投 | `NOTIFY_POLL_SECONDS`（默认 60） | 渠道整轮失败后，下一轮调度重新渲染消息再投，直到成功；邮件成功不会清掉 Webhook 的失败记录（渠道级独立） |

管理页 `attempts` 列是**状态写入次数**（每次投递结果落库 +1），不是 HTTP 请求次数：
一次 `WEBHOOK_MAX_ATTEMPTS=3` 的全失败，在管理页只让 `attempts` 加 1。
把它设成 `1` 不等于放弃投递，只是不再即时重试。

> `NOTIFY_FAILURE_ALERT_AFTER=3` 是 Cloud 拉取连续失败 3 轮发系统告警，与 Webhook 投递重试无关。

### 4.8 M3 扩展（全部默认关闭）

| 键                         | 默认值              | 说明                                                                | 标记             |
| ------------------------- | ---------------- | ----------------------------------------------------------------- | -------------- |
| `NOTIFY_TAG_RULES`        | `false`          | 开启后标签路由生效                                                         | EXT-19 前半【官方无】 |
| `NOTIFY_TAG_SILENT`       | `silent`         | 命中则所有渠道都不投递（逗号分隔）                                                 | EXT-19         |
| `NOTIFY_TAG_EMAIL`        | `notify-email`   | 命中则只发邮件                                                           | EXT-19         |
| `NOTIFY_TAG_WEBHOOK`      | `notify-webhook` | 命中则只发 Webhook                                                     | EXT-19         |
| `NOTIFY_WEBHOOK_ADAPTERS` | 空                | 与 `WEBHOOK_URLS` 一一对应：`generic` / `dingtalk` / `wecom` / `feishu` | EXT-19         |
| `NOTIFY_WEBHOOK_SECRETS`  | 空                | 平台适配器各自的加签密钥，用逗号分隔，可留空位                                           | EXT-19         |
| `NOTIFY_ALLOW_WRITE`      | `false`          | 双向完成的第一道开关                                                        | EXT-19         |
| `NOTIFY_COMPLETE_ACTION`  | `false`          | 双向完成的第二道开关                                                        | EXT-19         |

> ⚠️ 后两项必须**同时**为 `true` 才可能构造写请求，且 CLI / Scheduler / Dispatcher 都不调用它，  
> **默认永不向 Cloud 发写请求**。启用前需按 `spec.md` §13 做冲突评审与单独授权；本项目按只读约束主动不启用。

### 4.9 M4 管理页与命名空间

| 键                          | 默认值       | 说明                                       | 标记             |
| -------------------------- | --------- | ---------------------------------------- | -------------- |
| `NOTIFY_NAMESPACE`         | `default` | 配置 / 状态库 / 去重键按命名空间隔离                    | EXT-19 后半【官方无】 |
| `NOTIFY_CONFIG`            | 空         | 可选 JSON 配置文件路径，支持 `namespaces.<ns>` 分段覆盖 | EXT-19         |
| `NOTIFY_ADMIN_PAGE`        | `true`    | 是否挂载 `GET /admin` 只读页面                   | EXT-19         |
| `NOTIFY_ADMIN_TOKEN`       | 空         | 管理接口鉴权；留空则回退 `HEALTHZ_TOKEN`             | EXT-19         |
| `NOTIFY_ADMIN_RETRY`       | `false`   | 手动重发总开关，`true` + 有效 token 才放行            | EXT-19         |
| `NOTIFY_ADMIN_MAX_RECORDS` | `100`     | 管理页每个列表最多返回条数（上限 500）                    | EXT-19         |

### 4.10 运维专用（不要写进部署用 `.env`）

| 键         | 说明                                                        |
| --------- | --------------------------------------------------------- |
| `SSH_URI` | 本机远程运维脚本读取的连接串，产品代码**完全不读**；因 `env_file` 全量注入，放进去只会无谓带进容器 |

---

## 5. Webhook 验签协议（通用 `generic` 通道）

| 请求头                  | 值              |
| -------------------- | -------------- |
| `X-Notify-Timestamp` | Unix 秒         |
| `X-Notify-Signature` | `sha256=<hex>` |

**签名串 = `<timestamp>.<rawBody>`**，其中 `rawBody` 必须是发送时的原始 JSON 字节。  
接收方**不能把 JSON 重新序列化后再验签**（空格、字段顺序变化都会验不过）。  
时间戳偏差超过 300 秒直接拒绝，防止重放。

接收端校验示例（Node，零依赖）：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// 参数：secret 为 WEBHOOK_SECRET，rawBody 必须是未经改动的原始请求体字符串
function verify(secret, timestamp, rawBody, signature) {
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody).digest('hex');
  const provided = String(signature).replace(/^sha256=/, '');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(provided, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
```

> **完整出站格式清单见 [Webhook 输出数据格式](webhook-payload.md)**：14 种 `event` 的完整字段表与  
> JSON 样例、四种适配器的 body 结构、重试与幂等语义、隐私边界。  
> 钉钉与飞书各有自己的加签算法，**企业微信没有签名**（密钥在 Webhook URL 里），  
> 三者都不走上面的通用 HMAC；多个 URL 时用 `NOTIFY_WEBHOOK_ADAPTERS` 逐个声明类型。

---

## 6. 典型配置样例

### 6.1 最小只读（只验计划，不投递）

```dotenv
MINDWTR_BASE_URL=https://<你的-cloud-域名>
MINDWTR_TOKEN=<完整 bearer token>
```

### 6.2 只发 Webhook

```dotenv
MINDWTR_BASE_URL=https://<你的-cloud-域名>
MINDWTR_TOKEN=<完整 bearer token>
WEBHOOK_ENABLED=true
WEBHOOK_URLS=https://hooks.example.com/notify
WEBHOOK_SECRET=<自定义签名密钥>
NOTIFY_ADMIN_TOKEN=<自定义管理令牌>
```

### 6.3 邮件 + Webhook 双通道

```dotenv
MINDWTR_BASE_URL=https://<你的-cloud-域名>
MINDWTR_TOKEN=<完整 bearer token>
SMTP_ENABLED=true
SMTP_HOST=<smtp 服务商地址>
SMTP_PORT=587
SMTP_USER=<账号>
SMTP_PASS=<密码或应用专用密码>
SMTP_FROM=<发件地址>
SMTP_TO=<收件地址>
WEBHOOK_ENABLED=true
WEBHOOK_URLS=https://hooks.example.com/notify
WEBHOOK_SECRET=<自定义签名密钥>
```

> 渠道彼此独立：邮件成功不会让失败的 Webhook 失去重试机会，反之亦然。

### 6.4 多命名空间（同一镜像跑两套隔离实例）

`.env` 里指定命名空间与 JSON 路径：

```dotenv
NOTIFY_NAMESPACE=work
NOTIFY_CONFIG=notify-namespaces.json
```

`notify-namespaces.json`：

```json
{
  "namespaces": {
    "work": {
      "NOTIFY_TIMEZONE": "Asia/Shanghai",
      "WEBHOOK_ENABLED": "true",
      "WEBHOOK_URLS": "https://hooks.example.com/work"
    },
    "personal": {
      "NOTIFY_TIMEZONE": "Asia/Shanghai",
      "WEBHOOK_ENABLED": "false"
    }
  }
}
```

段内键名与 `.env` 相同，值会被转成字符串。非默认命名空间的状态库自动派生为  
`data/notify-work.sqlite`，去重键加 `ns=work:` 前缀，两套实例互不干扰。  
⚠️ 但**两套实例仍不能共用同一个状态库卷**；若用 Compose 跑多套，请用不同项目名与不同卷。

---

## 7. 安全注意事项

1. `MINDWTR_TOKEN`、`SMTP_PASS`、`WEBHOOK_SECRET`、管理 token 只放 `.env`（权限 600、已被 `.gitignore` 排除），  
   不写进日志、报告、聊天、文档或任何云端资源。
2. 部署用 `.env` **最小化**：`env_file` 会把每一行都注入容器，`SSH_URI` 之类运维键不要放进去。
3. 校验配置用 `docker compose config --quiet`；裸 `config` 会把 `env_file` 展开成明文打印，含 token。
4. Webhook URL 可能含密钥：状态库里只记 `webhook:N` 这样的短渠道名；页面展示的错误文本也会脱敏 URL 与长串标识。
5. 管理 token 由浏览器临时输入，放在请求头（`X-Admin-Token` 或 `Authorization: Bearer`），  
   不进 URL、不写 localStorage、不进服务端日志。
6. 对生产实例只有白名单内的 `GET`；`NOTIFY_ALLOW_WRITE` / `NOTIFY_COMPLETE_ACTION` 保持 `false`。
7. **日志也要脱敏**：`src/errors.ts` 的 `redactUrls` 是状态库与日志共用的脱敏入口，  
   新增日志一律走 `src/logger.ts`，不要直接 `console.log` 带 URL / 异常原文的内容。

---

## 8. 改了配置怎么生效

| 改了什么           | 生效方式                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `.env` 内容      | `docker compose up -d --force-recreate`（容器环境变了必须重建）                     |
| `compose.yaml` | `docker compose config --quiet && docker compose up -d`                 |
| 产品代码 `src/`    | `docker compose up -d --build`                                          |
| 只看计划、不重建       | 本机 `npm run dry-run`，或容器内 `bun run src/cli.ts --dry-run --strict`       |
| **临时**调日志级别    | CLI 加 `--log-level=debug`，**不用改 `.env`、不用重建容器**                         |
| **长期**调日志级别    | 改 `.env` 的 `NOTIFY_LOG_LEVEL` 后 `docker compose up -d --force-recreate` |


> 改完先 `docker compose ps` 确认仍是 `healthy`，再看一眼 `curl http://127.0.0.1:8788/healthz`。

---

## 9. 日志级别与排障（EXT-20【官方无】）

`NOTIFY_LOG_LEVEL` 只控制**运行时诊断日志**的详细程度，默认 `info`（输出量与 v1.12 及以前一致）。

| 值 | 会看到什么 | 适合场景 |
|---|---|---|
| `debug` | 全部：每个 Cloud GET 的路径 / 状态 / 耗时、项目缓存命中、计划条数、逐条触发点的窗口决策、渠道去重与投递结果、退避计算 | 排障、确认只读链路、核对规则 |
| `info` | 启动信息、每轮汇总、Cloud 连接恢复 | **日常运行（推荐）** |
| `warn` | 拉取失败、渠道投递失败、连续失败、配置告警 | 只想看异常 |
| `error` | 调度轮次异常、管理页处理失败、运行失败 | 最小化输出 |
| `silent` | 一条日志都不输出 | 特殊场景（命令输出仍然在） |

输出格式固定为「时间 + 级别 + 前缀 + 消息 + 结构化字段」：

```text
2026-11-15 20:34:35 [DEBUG] [notify] Cloud GET 完成 path=/v1/tasks status=200 ms=681
```

时间戳按 `NOTIFY_TIMEZONE`（默认 `Asia/Shanghai`）渲染，与业务提醒时刻一致；
`debug` / `info` 走 stdout，`warn` / `error` 走 stderr，便于日志采集分流。

### 9.1 临时开 debug，不用改 `.env`

```bash
# 本机：命令行优先级高于 NOTIFY_LOG_LEVEL
node src/cli.ts --dry-run --strict --log-level=debug
NOTIFY_LOG_LEVEL=debug npm run dry-run

# 容器内：不必重建容器
docker compose exec mindwtr-notify bun run src/cli.ts --dry-run --strict --log-level=debug

# 常驻服务想长期开 debug：改 .env 后必须重建（env_file 变了要 --force-recreate）
docker compose up -d --force-recreate
```

### 9.2 三条必须知道的边界

1. **命令输出不受级别影响**。`--dry-run` 的计划、`--once` 的投递结果、`--test-email` / `--test-webhook`
   的结论、`--help`、配置错误提示，都是「命令给人看的输出」而不是日志，即使 `silent` 也照常打印。
2. **日志不泄密**。正文与结构化字段统一过 `redactUrls`，Webhook URL 会被替换成 `[url]`；
   debug 只记录路径、状态、耗时、任务 id、触发类型、渠道短名（如 `webhook:0`）与计数，
   **不记录** token、密码、Webhook 地址、任务标题 / 正文；`/healthz?token=` 的查询串也不进日志。
3. **填错不会让服务起不来**。`.env` 里写非法值会回退 `info` 并打一条 `WARN` 说明可选值；
   命令行 `--log-level=` 给非法值则直接报错退出，避免「以为开了 debug 其实没有」。
