/**
 * 调度器：M1 的轮询循环 + M2 的失败告警 / 恢复通知
 * （M4 的 upcoming() 属 EXT-19【官方无】，只读计划缓存、不产生触发点）
 *
 * 一轮的流程固定为：
 *   只读拉取任务与项目 → 生成统一计划（strict 时只含基线）→ 按补发窗口过滤
 *   → 渠道级去重 → 渲染消息 → 投递 → 记录成败。
 *
 * 三条重要边界：
 *   1. 补发窗口 5 分钟（BASE-27）：服务短停机错过可补，早于窗口的触发点标 skipped_late 不补发；
 *   2. catch_up=false 时，任何过去时刻的触发点都不补发（区分「服务停机」与「数据迟到」）；
 *   3. dry-run 不投递、不写状态库，只把计划交给调用方打印，保证验收可重复。
 */

import type { NotifyConfig } from './config.ts';
import { summarizeError, type CloudClient } from './cloud/client.ts';
import { describeError } from './errors.ts';
import { createLogger, type EmitLevel, type LogFields, type Logger } from './logger.ts';
import { channelDedupeKey, recordDelivery, type Dispatcher } from './dispatch/index.ts';
import type { EmailContent, NotifyMessage } from './dispatch/message.ts';
import { renderEmail, renderMessage } from './dispatch/message.ts';
import { buildPlan, type PlannedNotification } from './rules/plan.ts';
import { filterChannelsByTags } from './rules/tag-policy.ts';
import type { StateStore } from './state/store.ts';
import type { MindwtrProject } from './types.ts';

export interface RunOnceResult {
  /** 本轮计划项总数（含未到点、已过期的）。 */
  planned: number;
  /** 落在发送窗口内、需要处理的条数。 */
  due: number;
  /** 成功投递的渠道数。 */
  sent: number;
  failed: number;
  skippedLate: number;
  duplicates: number;
  errors: string[];
  /** 完整计划，供 --dry-run 打印与 §18 集合比对使用。 */
  plan: PlannedNotification[];
  /** 本轮实际拉取到的任务/项目数，用于确认只读链路确实工作。 */
  taskCount: number;
  projectCount: number;
}

export interface SchedulerStatus {
  ok: boolean;
  lastPollAt: number | null;
  lastErrorCount: number;
  pendingCount: number;
  channelStatus: Record<string, { status: string; at: number }>;
  lastPlanCount: number;
}

/** M4 管理页「下一批待触发提醒」的一行。只读缓存，不含任务正文。 */
export interface UpcomingItem {
  kind: string;
  taskId: string;
  scheduledAt: number;
  event: string;
}

export interface Scheduler {
  runOnce(options?: { dryRun?: boolean; strict?: boolean }): Promise<RunOnceResult>;
  status(): SchedulerStatus;
  /**
   * M4 · EXT-19【官方无】：返回最近一轮计划里「还没到点」的前若干条。
   * 数据来自 runOnce 已算好的计划缓存，不额外拉云端、不重算、不产生触发点。
   */
  upcoming(limit?: number): UpcomingItem[];
  /** 常驻循环，间隔由 CloudClient.nextDelayMs() 决定（正常 60s，失败时指数退避）。 */
  start(strict?: boolean): void;
  stop(): void;
}

export interface SchedulerDeps {
  config: NotifyConfig;
  cloud: CloudClient;
  store: StateStore;
  dispatcher: Dispatcher;
  /** 可注入的时钟，便于单元测试。 */
  now?: () => number;
  /** v1.12 及以前的「单函数日志」注入；优先于 logger，且只转发 info 及以上。 */
  log?: (message: string) => void;
  /** EXT-20【官方无】：分级日志器；不传时按 config.logLevel 自动创建。 */
  logger?: Logger;
}

/** HTML 转义，系统告警文本里可能带尖括号。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { config, cloud, store, dispatcher } = deps;
  const nowFn = deps.now ?? Date.now;
  const logger = deps.logger ?? createLogger({ level: config.logLevel, timezone: config.timezone });

  /**
   * 统一日志出口（EXT-20【官方无】）。
   * 为什么要兼容 deps.log：v1.12 及以前的单元测试注入单函数 log 来收集消息，
   * 注入时只转发 info 及以上，不把新增的 debug 混进旧断言，旧用例行为完全不变。
   * debug 内容只含 id / kind / 时刻 / 渠道名 / 计数，绝不含任务正文、URL 或凭据。
   */
  function emit(level: EmitLevel, message: string, fields?: LogFields): void {
    if (deps.log) {
      if (level !== 'debug') deps.log(message);
      return;
    }
    logger[level](message, fields);
  }

  let lastPollAt: number | null = null;
  let lastPlanCount = 0;
  /** 最近一轮的完整计划；管理页只读它，不触发任何新的计算或网络请求。 */
  let lastPlan: PlannedNotification[] = [];
  let lastErrorCount = 0;
  let lastSystemAlertAt = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 系统级告警（EXT-11【官方无】）：Cloud API 连续失败 / 恢复时发一条。
   * 这类消息不进 sent_log，只用 60 秒节流，避免告警本身变成骚扰。
   */
  async function sendSystemNote(subject: string, text: string, now: number): Promise<void> {
    if (!dispatcher.channels.length) return;
    if (now - lastSystemAlertAt < 60_000) return;
    lastSystemAlertAt = now;

    const message: NotifyMessage = {
      event: 'system',
      note: text,
      sentAt: new Date(now).toISOString(),
    };
    const email: EmailContent = {
      to: config.channels.email.to.length ? config.channels.email.to : ['unused@localhost'],
      subject,
      text,
      html: `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`,
    };
    try {
      await dispatcher.deliver({ message, email });
    } catch (error) {
      emit('warn', `系统告警投递失败：${summarizeError(error)}`);
    }
  }

  /** 执行一轮。dryRun 只算计划不投递，strict 关闭全部 A 类扩展。 */
  async function runOnce(options: { dryRun?: boolean; strict?: boolean } = {}): Promise<RunOnceResult> {
    const dryRun = options.dryRun ?? false;
    const strict = options.strict ?? config.strictMode;
    const now = nowFn();
    const result: RunOnceResult = {
      planned: 0, due: 0, sent: 0, failed: 0,
      skippedLate: 0, duplicates: 0, errors: [], plan: [],
      taskCount: 0, projectCount: 0,
    };

    emit('debug', '开始新一轮调度', {
      dryRun, strict, namespace: config.namespace, now: new Date(now).toISOString(),
    });

    // 1. 只读拉取。任何失败都退避，不产生业务提醒。
    let tasks;
    let projects: ReadonlyMap<string, MindwtrProject>;
    let projectNames: ReadonlyMap<string, string>;
    try {
      const [taskResult, projectList] = await Promise.all([
        cloud.fetchActiveTasks(),
        cloud.fetchProjects(),
      ]);
      tasks = taskResult.items;
      projects = new Map(projectList.map(project => [project.id, project]));
      projectNames = new Map(projectList.map(project => [
        project.id,
        typeof project.title === 'string' ? project.title : '',
      ]));

      const success = cloud.recordSuccess();
      lastErrorCount = 0;
      result.taskCount = tasks.length;
      result.projectCount = projectList.length;
      emit('debug', 'Cloud 拉取完成', {
        tasks: tasks.length, projects: projectList.length,
      });
      if (success.recovered) {
        await sendSystemNote('[Notify] Cloud API 已恢复', 'Mindwtr Cloud 连接已恢复，提醒服务继续运行。', now);
      }
    } catch (error) {
      const reason = summarizeError(error);
      const { failures } = cloud.recordFailure(reason);
      lastErrorCount = failures;
      emit('warn', 'Cloud 拉取失败', { failures, reason });
      result.errors.push(reason);
      if (failures === config.enhancements.reliability.pollFailureAlertAfter) {
        await sendSystemNote('[Notify] Cloud API 连续失败', `已连续 ${failures} 轮拉取失败，最后错误：${reason}`, now);
      }
      return result;
    }

    lastPollAt = now;

    // 2. 生成统一计划。strict 下 A 类扩展不参与。
    const plan = buildPlan({ tasks, projects, config, now, strict, store });
    result.plan = plan;
    result.planned = plan.length;
    lastPlanCount = plan.length;
    lastPlan = plan; // M4：供管理页展示「下一批待触发提醒」，不写库、不投递。
    emit('debug', '计划生成完成', { planned: plan.length, windowMs: config.gracePeriodMs });

    // 3. 逐条按窗口过滤、逐渠道去重与投递。
    for (const item of plan) {
      if (item.scheduledAt > now) continue; // 还没到点

      const age = now - item.scheduledAt;
      const tooLate = age > config.gracePeriodMs || (!config.catchUp && age > 0);
      if (tooLate) {
        result.skippedLate += 1;
        emit('debug', '触发点过期跳过', {
          kind: item.kind, taskId: item.taskId ?? '-', ageMs: age,
        });
        if (!dryRun) {
          // 只记一次，避免每轮都为同一条过期触发点重复写库。
          const lateKey = `${item.dedupeKey}:late`;
          if (!store.hasSent(lateKey)) {
            store.markPending(lateKey, {
              taskId: item.taskId ?? '', triggerType: item.kind,
              triggerAt: item.scheduledAt, channel: 'none',
            });
            store.markSkippedLate(lateKey);
          }
        }
        continue;
      }

      result.due += 1;
      if (dryRun) continue;

      const message = renderMessage(item, projectNames);
      const email = renderEmail(item, message, config);
      let deliveredAny = false;

      // M3 标签路由：只过滤「发到哪些渠道」，不增删触发点、不改时刻。
      const channels = filterChannelsByTags(item.task, dispatcher.channels, config);
      emit('debug', '触发点到点', {
        kind: item.kind, taskId: item.taskId ?? '-', channels: channels.length,
      });
      for (const channel of channels) {
        const key = channelDedupeKey(item.dedupeKey, channel);
        if (store.hasSent(key)) {
          result.duplicates += 1;
          emit('debug', '渠道已投递过，跳过', { channel });
          continue;
        }
        const delivery = await dispatcher.deliverChannel(channel, { message, email });
        emit('debug', '渠道投递结果', {
          channel, ok: delivery.ok, attempts: delivery.attempts,
        });
        recordDelivery(store, key, delivery, {
          taskId: item.taskId ?? '',
          triggerType: item.kind,
          triggerAt: item.scheduledAt,
          channel,
        });
        if (delivery.ok) {
          result.sent += 1;
          deliveredAny = true;
        } else {
          result.failed += 1;
          const reason = describeError(delivery.error, '未知错误');
          result.errors.push(`${channel}: ${reason}`);
          emit('warn', '渠道投递失败', { channel, reason });
        }
      }

      // backlog 节流：投递成功后才记时间，失败时下一轮仍可重试。
      if (item.kind === 'backlog' && deliveredAny) {
        store.setMeta('last_backlog_at', String(now));
        emit('debug', 'backlog 节流时间已更新');
      }
    }

    if (!dryRun) {
      emit('info', `本轮：计划 ${result.planned} 条，到点 ${result.due} 条，成功 ${result.sent}，失败 ${result.failed}，过期 ${result.skippedLate}`);
    }
    return result;
  }

  /** 常驻循环。用 setTimeout 串联而非 setInterval，方便按退避动态调整下一轮间隔。 */
  async function loop(strict: boolean): Promise<void> {
    if (!running) return;
    try {
      await runOnce({ strict });
    } catch (error) {
      emit('error', `调度轮次异常：${summarizeError(error)}`);
    }
    if (running) {
      const delay = cloud.nextDelayMs();
      emit('debug', '调度轮次结束', { nextDelayMs: delay });
      timer = setTimeout(() => void loop(strict), delay);
    }
  }

  return {
    runOnce,

    status() {
      return {
        ok: lastErrorCount === 0,
        lastPollAt,
        lastErrorCount,
        pendingCount: store.pendingCount(),
        channelStatus: store.channelStatus(),
        lastPlanCount,
      };
    },

    upcoming(limit = 20) {
      const now = nowFn();
      const capped = Math.max(1, Math.min(limit, 200));
      // 计划已按时间升序（buildPlan 末尾 sort），过滤未来项后取前 N 条即可。
      return lastPlan
        .filter(item => item.scheduledAt > now)
        .slice(0, capped)
        .map(item => ({
          kind: item.kind,
          taskId: item.taskId ?? '',
          scheduledAt: item.scheduledAt,
          event: item.event,
        }));
    },

    start(strict = false) {
      if (running) return;
      running = true;
      emit('debug', '调度循环启动', { strict });
      void loop(strict);
    },

    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      emit('debug', '调度循环停止');
    },
  };
}
