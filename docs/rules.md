# Notify 提醒规则手册

> 对应 `spec.md` **v1.25**。权威规则在 `spec.md` §15（BASE-01…29）与 §16（EXT 扩展），
> 本文把「什么情况下会提醒」整理成一份可读版本，方便日常查、不用读规则源码。
> 每条都标了对应的 BASE / EXT 编号，需要原始定义时按编号回查 `spec.md`。

**一句话**：一条任务要**同时**过五道关才会发提醒；摘要类是独立触发点，
三个 A 类扩展（仅日期汇总、积压清单、静默时段）默认全关，开启后才会改变发送行为。

代码位置：任务级触发点 `src/rules/reminder-plan.ts`、摘要与扩展 `src/rules/plan.ts`、
窗口与投递 `src/scheduler.ts`、消息渲染 `src/dispatch/message.ts`。

---

## 1. 五道关（缺一条就不提醒）

| # | 条件 | 不满足时会怎样 | 规则 |
|---|---|---|---|
| 1 | 任务状态**活跃**：`inbox` / `next` / `waiting` / `someday` | `done` / `archived` / `reference` 一律不提醒 | BASE-28 |
| 2 | 时间字段**带时刻**，形如 `2026-11-16T10:11` 或 `2026-11-16 10:11` | 只写日期（`2026-11-16`）→ 不产生任何任务级提醒 | BASE-21 / BASE-22 |
| 3 | 提醒**策略允许**（不是 `skip`） | `skip` 撤销开始/截止类；但**回顾仍会发** | BASE-18 |
| 4 | 对应**开关打开**（`NOTIFY_INCLUDE_START/DUE/REVIEW`） | 关掉就直接不排该类型提醒 | BASE-20 |
| 5 | 触发时刻**落在补发窗口内**：到点，或迟到 ≤ 5 分钟 | 更早的算「过期跳过」，不补发 | BASE-27 |

另外还有两条前置过滤：任务被删除 / 取消 / 已完成（`deletedAt` / `cancelledAt` / `completedAt`），
以及**任务所属项目已归档或已删除**，都不提醒（BASE-28）。

> ⚠️ **收集箱（`inbox`）也会提醒**。它属于活跃状态，和 `next` / `waiting` / `someday` 一样参与计算。
> 不想让它提醒，就别给收集箱任务设时间，或把任务策略设为 `skip`。

---

## 2. 触发类型全集

### 2.1 任务级（每条只看自己的字段）

| 类型 | 触发时刻 | 什么时候会生成 | 规则 |
|---|---|---|---|
| `start` | `startTime` | 任务有带时刻的开始时间 | BASE-01 |
| `start-advance` | `startTime − startReminderLeadMinutes` | 任务设了开始提前量（只接受 `0/5/15/30/60`） | BASE-02 |
| `due` | `dueDate` | 任务有带时刻的截止时间 | BASE-03 |
| `due-advance` | `dueDate − dueReminderLeadMinutes` | 任务设了截止提前量（`0–10080` 分钟，UI 预设 `5/15/30/60/1440/2880/10080`） | BASE-04 |
| `due-repeat` | `dueDate + n × repeatReminderMinutes` | 任务设了重复间隔（只接受 `5/10/15/30/60`） | BASE-05 |
| `review` | `reviewAt` | 任务有带时刻的回顾时间；**策略为 `skip` 也照发** | BASE-06 |
| `project-review` | 项目的 `reviewAt` | 项目有带时刻的回顾时间，且项目未归档 / 未删除；仅日期不排 | BASE-07 |

### 2.2 摘要类（按时刻触发，不看任务策略）

| 类型 | 默认时刻 | 内容 | 开关 | 规则 |
|---|---|---|---|---|
| `digest_morning` | 每天 **09:00** | 今日到期 + 已逾期 + 专注任务 | `NOTIFY_DIGEST_MORNING`（默认开） | BASE-08 |
| `digest_evening` | 每天 **20:00** | 晚间回顾 | `NOTIFY_DIGEST_EVENING`（默认开） | BASE-09 |
| `digest_weekly` | **周日 18:00** | 每周回顾 | `NOTIFY_DIGEST_WEEKLY`（默认开） | BASE-10 |

> 时刻目前是**写死的**（`09:00 / 20:00 / 周日 18:00`），环境变量只能开关；要改时刻得改代码。
> 摘要去重键是 `kind + YYYY-MM-DD`，所以一天只发一次，服务重启也不会重发。

### 2.3 默认关闭的扩展触发点（A 类，`strict` 下强制关闭）

| 类型 | 触发时刻 | 什么时候会生成 | 开关 | 规则 |
|---|---|---|---|---|
| `date_only` | 每天 **09:00** | 把「只有日期、没有时刻」的任务汇总成一条 | `NOTIFY_DATE_ONLY=true` | EXT-16 |
| `backlog` | 服务启动后的首轮 | 逾期未完成清单；**24 小时只发一次** | `NOTIFY_BACKLOG=true` | EXT-17 |
| 静默时段顺延 | — | 提醒落在静默时段就顺延到解禁时刻，**不叠加补发** | `NOTIFY_QUIET_HOURS=true` | EXT-18 |

`NOTIFY_STRICT=true` 会让这三项一律不参与，输出与官方算法完全一致。

> 严格说，`date_only` 与 `backlog` 是**新增触发点**，静默时段只是把**已有**触发点的时刻往后挪，
> 所以「新增触发类型」是前两项；另外 `system` / `test` 属于系统事件，不在任务级 `kind` 里。

### 2.4 系统类

| 类型 | 触发时刻 | 说明 | 规则 |
|---|---|---|---|
| `system` | Cloud 连续失败 3 轮 | 告警内容含脱敏后的失败原因；60 秒内最多一条；恢复时也通知一次 | EXT-11 |
| `test` | 手动 `--test-webhook` / `--test-email` | 渠道自检，只发一条 | EXT-01 |

---

## 3. 提醒策略（决定发哪几类）

优先级（BASE-16）：`reminderPolicy` > `suppressMindwtrReminders=true`（等价 `skip`）> 全局默认 `NOTIFY_TASK_REMINDER_DEFAULT`（默认 `send`）。

| 策略 | 会发 | 不会发 |
|---|---|---|
| `send`（默认） | 该任务的全部任务级提醒（开始/截止/提前/重复/回顾） | — |
| `skip` | **只有 `review`** | `start` / `start-advance` / `due` / `due-advance` / `due-repeat` |
| `start` | 只有开始类 | 截止类、重复 |
| `due` | 只有截止类 | 开始类、重复 |
| `inherit` | 跟随全局默认 | — |

两条最容易记错的细节：

1. **`skip` 不撤「回顾」**（BASE-18）。官方语义是撤销待发的开始/截止及其重复，回顾独立。
2. **单一策略 + 设了提前量时，普通那条会被抑制**（BASE-19）：
   例如策略 `due` 且设了 `dueReminderLeadMinutes=30`，就只发 `due-advance`，不再发到点那条 `due`。

---

## 4. 时间怎么算

- **带时刻判定**（BASE-21）：正则 `/[T\s]\d{2}:\d{2}/`。`2026-11-16T00:00` **算**带时刻（因为有时分）。
- **仅日期不提醒**（BASE-22）：`2026-11-16` 这种不排任何任务级提醒（start/due/advance/repeat/review 全都不排）。
- **提前量算术**（BASE-23）：提前量是整天的倍数（`% 1440 === 0`）时按**日历日**回退，跨夏令时仍保持同一本地时刻；否则按分钟回退。
- **重复上限**（BASE-25）：次数 = `min(8, floor(120 / 间隔))`，窗口 120 分钟。

| 重复间隔 | 实际发几次 | 时间点 |
|---|---|---|
| 5 分 | 8 次 | 截止后 5…40 分 |
| 10 分 | 8 次 | 截止后 10…80 分 |
| 15 分 | 8 次 | 截止后 15…120 分 |
| 30 分 | 4 次 | 截止后 30/60/90/120 分 |
| 60 分 | 2 次 | 截止后 60/120 分 |

- **时区**：容器里要保证 `TZ` 与 `NOTIFY_TIMEZONE` 一致（都默认 `Asia/Shanghai`）。
  `TZ` 决定「不带时区的日期字符串」怎么解析，`NOTIFY_TIMEZONE` 决定时刻怎么渲染；
  只配前者或只配后者都会导致**差 8 小时**且不报错。详见 `docs/configuration.md` §4.2.1。
- **改时间**（BASE-24）：改了任务时间会自动重排；去掉时间就停止安排；新设的时间如果提前点已过，**不补发**。
- **显示格式**（EXT-21）：消息里的时间默认按 `yyyy-MM-dd HH:mm:ss` 渲染（业务时区），
  可用 `NOTIFY_TIME_FORMAT` 改；仅日期字段保持 `2026-11-16` 原样，结构化 JSON 仍是 ISO 8601。

---

## 5. 补发窗口、去重与重启

- **窗口**：到点即发；进程刚好没跑时，**迟到 5 分钟内**会补发（`NOTIFY_GRACE_MS=300000`）；超过就算「过期跳过」。
  这是为了避免服务停机几小时后一次性刷出几十条旧提醒。
- **`NOTIFY_CATCH_UP=false`** 可关闭补发，过去时刻的触发点一律不发。
- **去重键**（BASE-29 + EXT-07 渠道维度）：
  - 任务级：任务 id + 类型 + 触发时刻（ISO）+ 渠道
  - 截止重复：`dueDate#序号` + 渠道
  - 每日摘要：类型 + `YYYY-MM-DD` + 渠道
  - 每周回顾 / 项目回顾：日期或时间戳 + 渠道
- **重启不重发**：状态库在 SQLite 里，容器重启后已发过的不再发；但**删卷等于清空记录**，会重新发。
- **渠道级独立**：邮件成功、Webhook 失败时，只重投 Webhook；反之亦然。

---

## 6. 渠道投递（默认全部一起发送）

一条提醒触发后，**所有已启用的渠道都会收到**：邮件 + 每个配置好的 Webhook（含钉钉 / 企微 / 飞书适配器）。
渠道之间彼此独立：某渠道失败只重投该渠道，不影响其他渠道；已投递过的渠道在重启后也不会重复发。
不再支持按任务标签挑选渠道，`#silent` / `#notify-email` / `#notify-webhook` 这类标签只是普通文本，不会产生过滤效果。

---

## 7. 排查：为什么没提醒

按实际踩过的频率排序：

| 现象 | 最可能的原因 | 怎么确认 |
|---|---|---|
| 完全没动静 | **服务根本没在跑**（本机没起、容器没部署），或轮询间隔内没轮到 | 看进程 / `docker compose ps`；状态库 `sent_log` 是否有记录 |
| 设了时间却没提醒 | 只写了**日期**没写时刻 | 时间字段是否形如 `2026-11-16T10:11`；`npm run dry-run` 看计划条数 |
| 晚了几分钟才想起来 | 已超出 **5 分钟补发窗口** → 过期跳过 | `dry-run` 会显示「过期跳过 N 条」 |
| 全部时间都差 8 小时 | 容器 `TZ` 是 UTC | 容器内 `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| 单个任务不发 | 策略是 `skip`，或状态是 `done`/`archived` | 看任务 `reminderPolicy` 与状态 |
| 只有回顾在发 | 策略设成了 `start`/`due`，或 `skip`（回顾不受影响） | 同上 |
| 摘要没发 | 对应 `NOTIFY_DIGEST_*` 关了，或 `strict` 模式 | 看配置与启动日志的级别 |
| 项目回顾没发 | 项目**没有 `reviewAt` 字段**、只写了日期、或项目已归档 | 看 `GET /v1/projects` 返回里有没有 `reviewAt`；`include_review` 是否关掉 |
| 收集箱任务以为不提醒 | 实际上**会提醒**（`inbox` 属活跃状态） | 见 §1 提示 |
| 重复提醒只发了 1 次 | 没设 `repeatReminderMinutes`，或策略是 `start`/`due` | 单一策略下官方也不排重复 |
| 邮件全失败 | VPS 出站 25/465/587 被拒 | 改用 `SMTP_PORT=2587`，详见 `docs/configuration.md` §4.6 |

只读自查命令：

```bash
npm run dry-run                                   # 本机：只读算一轮计划，不投递不写库
node src/cli.ts --dry-run --strict --log-level=debug   # 带完整判定链路
```

---

## 8. 已知边界（如实标注）

1. **项目回顾依赖 `reviewAt` 字段**：官方 schema 有该字段，但当前测试实例的项目接口里**根本没有这个键**
   （实测项目字段只有 `color/createdAt/id/isFocused/isSequential/order/rev/status/title/...`）。
   代码已按「有该字段就提醒」实现并有单测覆盖，但在真实数据上暂时无法验证；
   字段一旦出现（客户端升级 / 手动写入）即自动生效，无需改代码。
2. **客户端本地能力不模拟**（BASE-11）：番茄钟、Snooze / Dismiss、iOS 角标、设备通知权限。
3. **平台文本有截断**：钉钉 / 企微 / 飞书的摘要只列「今日到期 + 逾期」的前 5 条，`startingToday` / `focused`
   不出现在文本里（结构化 Webhook 才有完整数据）。
4. **摘要时刻不可配**：`09:00 / 20:00 / 周日 18:00` 写死在 `src/config.ts`，环境变量只能开关。

---

## 9. 索引

| 想查什么 | 去哪里 |
|---|---|
| 规则原始定义（29 条 BASE + 20 条 EXT） | `spec.md` §15 / §16 |
| 任务级触发点实现 | `src/rules/reminder-plan.ts` |
| 项目回顾触发点实现 | `src/rules/plan.ts` 的 `fromProjectReviews` |
| 摘要 / `date_only` / `backlog` / 静默时段实现 | `src/rules/plan.ts` |
| 窗口、去重、投递、告警 | `src/scheduler.ts` |
| 提醒策略判定 | `src/rules/reminder-plan.ts` |
| 配置开关与默认值 | `docs/configuration.md` §4.2 / §4.3 / §4.4 |
| 消息长什么样（各渠道字段） | `docs/webhook-payload.md` |
| 部署与排障 | `docs/deployment.md` |
| 管理页查看「下一批待触发」 | `docs/admin-guide.md` |
