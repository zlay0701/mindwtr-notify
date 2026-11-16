/**
 * 统一提醒计划
 *
 * 把三类来源汇总成同一种「待投递项」，Scheduler 只需遍历一个数组：
 *   1. 任务级触发点 —— 只来自 §15 清单 A（BASE），strict 基线保持纯净；
 *   2. 三类摘要 —— BASE-08/09/10（M2）；
 *   3. A 类扩展 —— EXT-16/17/18【官方无】，默认关闭，strict 下强制关闭。
 *
 * 这里仍然不发送任何东西、不写数据库；静默时段只调整 scheduledAt。
 * 这样「要不要发、什么时候发」与「怎么发」彻底分离，方便按 spec §18 做集合比对。
 */

import type { NotifyConfig } from '../config.ts';
import type { StateStore } from '../state/store.ts';
import type { MindwtrProject, MindwtrTask, ReminderTrigger } from '../types.ts';
import { getTaskReminderPlan, hasTimeComponent, isTaskInArchivedProject } from './reminder-plan.ts';
import { getZonedParts, localDateKey, parseHm, parseTaskDate, zonedTimeToEpoch } from './time.ts';

/** 摘要里允许外发的任务字段。刻意不含 description 等正文（EXT-03 数据最小化）。 */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  dueDate?: string;
  startTime?: string;
}

/** 晨间简报 / 晚间回顾的内容。 */
export interface DigestPayload {
  dueToday: TaskSummary[];
  overdue: TaskSummary[];
  startingToday: TaskSummary[];
  focused: TaskSummary[];
}

/** 一条统一的待投递通知。dedupeKey 不含 channel，渠道维度由 StateStore 追加。 */
export interface PlannedNotification {
  event: string;
  kind: string;
  scheduledAt: number;
  dedupeKey: string;
  taskId?: string;
  task?: MindwtrTask;
  /** 项目回顾（BASE-07）用；只带 id 与标题，不外发项目其它字段。 */
  projectId?: string;
  project?: { id: string; title?: string };
  trigger?: {
    type: string;
    at: string;
    leadMinutes?: number;
    repeatIndex?: number;
  };
  digest?: DigestPayload;
  backlog?: { count: number; tasks: TaskSummary[] };
}

export interface BuildPlanOptions {
  tasks: MindwtrTask[];
  projects: ReadonlyMap<string, MindwtrProject>;
  config: NotifyConfig;
  now: number;
  /** true 时关闭全部 A 类扩展（strict 验收用）。 */
  strict: boolean;
  /** backlog 节流只需要读元数据；写入由 Scheduler 在投递成功后完成。 */
  store: Pick<StateStore, 'getMeta'>;
}

const DAY_MS = 24 * 60 * 60_000;

/** 生成外发用的任务摘要，只挑允许的字段。 */
function summarizeTask(task: MindwtrTask): TaskSummary {
  return {
    id: task.id,
    title: typeof task.title === 'string' ? task.title : '(无标题)',
    status: task.status,
    ...(task.dueDate ? { dueDate: String(task.dueDate) } : {}),
    ...(task.startTime ? { startTime: String(task.startTime) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 一、任务级触发点（BASE-01…07）
// ---------------------------------------------------------------------------

/** 把官方规则的触发点转成统一计划项，并套用归档项目过滤（BASE-28）。 */
function fromTaskTriggers(options: BuildPlanOptions): PlannedNotification[] {
  const { tasks, projects, config } = options;
  const planOptions = {
    globalDefault: config.officialRules.taskReminderDefault,
    includeStart: config.officialRules.includeStart,
    includeDue: config.officialRules.includeDue,
    includeReview: config.officialRules.includeReview,
  };

  const result: PlannedNotification[] = [];
  for (const task of tasks) {
    // 归档/删除项目中的任务不提醒（官方 ICS 与 iOS 角标也是这个行为）。
    if (isTaskInArchivedProject(task, projects)) continue;

    for (const trigger of getTaskReminderPlan(task, planOptions)) {
      result.push({
        event: `task.${trigger.kind.replace(/-/g, '_')}`,
        kind: trigger.kind,
        scheduledAt: trigger.scheduledAt,
        // BASE-29：重复提醒用 dueDate#index，其余用任务 id + ISO 时间戳。
        dedupeKey: buildTaskDedupeKey(task, trigger),
        taskId: task.id,
        task,
        trigger: {
          type: trigger.kind,
          at: new Date(trigger.scheduledAt).toISOString(),
          ...(trigger.leadMinutes !== undefined ? { leadMinutes: trigger.leadMinutes } : {}),
          ...(trigger.repeatIndex !== undefined ? { repeatIndex: trigger.repeatIndex } : {}),
        },
      });
    }
  }
  return result;
}

/** 任务级去重键，严格照抄官方语义（BASE-29）。 */
function buildTaskDedupeKey(task: MindwtrTask, trigger: ReminderTrigger): string {
  if (trigger.kind === 'due-repeat') {
    return `${String(task.dueDate)}#${trigger.repeatIndex ?? 0}`;
  }
  return `${task.id}:${trigger.kind}:${new Date(trigger.scheduledAt).toISOString()}`;
}

// ---------------------------------------------------------------------------
// 二、项目回顾（BASE-07）
// ---------------------------------------------------------------------------

/**
 * 项目回顾触发点（BASE-07）：项目的 `reviewAt` 到点提醒。
 *
 * 三个容易写错的点：
 *   1. 项目回顾**不受任务策略影响**（没有 reminderPolicy 可读），只受设备级「回顾」开关控制
 *      （BASE-20 的 include_review），所以这里只判 `includeReview`；
 *   2. 仅日期（`2026-11-16`）不排提醒，与任务侧复用同一个 `hasTimeComponent`（BASE-22）；
 *   3. 去重键按官方语义是「每项目 + ISO 时间戳」（BASE-29），所以改了回顾时间会重新提醒一次。
 *
 * 已删除 / 已归档的项目不提醒 —— 与任务侧的归档过滤保持一致。
 */
function fromProjectReviews(options: BuildPlanOptions): PlannedNotification[] {
  const { projects, config } = options;
  if (!config.officialRules.includeReview) return [];

  const result: PlannedNotification[] = [];
  for (const project of projects.values()) {
    if (project.status === 'archived' || project.deletedAt) continue;
    if (!hasTimeComponent(project.reviewAt)) continue;

    const reviewAt = Date.parse(String(project.reviewAt));
    if (!Number.isFinite(reviewAt)) continue;

    result.push({
      event: 'task.project_review',
      kind: 'project-review',
      scheduledAt: reviewAt,
      dedupeKey: `project-review:${project.id}:${new Date(reviewAt).toISOString()}`,
      projectId: project.id,
      project: {
        id: project.id,
        ...(typeof project.title === 'string' ? { title: project.title } : {}),
      },
      trigger: { type: 'project-review', at: new Date(reviewAt).toISOString() },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 三、三类摘要（BASE-08 / 09 / 10）
// ---------------------------------------------------------------------------

/** 汇总今日到期、已逾期、今日开始、专注任务。所有日期都按配置时区判定。 */
export function buildDigestPayload(tasks: MindwtrTask[], now: number, timeZone: string): DigestPayload {
  const today = getZonedParts(now, timeZone).dateKey;
  const payload: DigestPayload = { dueToday: [], overdue: [], startingToday: [], focused: [] };

  for (const task of tasks) {
    const summary = summarizeTask(task);
    const dueAt = parseTaskDate(task.dueDate);
    if (dueAt !== null) {
      const key = localDateKey(dueAt, timeZone);
      if (key === today) payload.dueToday.push(summary);
      else if (key < today) payload.overdue.push(summary);
    }
    const startAt = parseTaskDate(task.startTime);
    if (startAt !== null && localDateKey(startAt, timeZone) === today) {
      payload.startingToday.push(summary);
    }
    if (task.isFocusedToday === true) payload.focused.push(summary);
  }
  return payload;
}

/**
 * 摘要触发判定。
 *
 * 不用「当前分钟 == 配置分钟」这种脆弱判断：轮询有间隔，错过那一分钟就漏发。
 * 改成「触发时刻已到，且还在本轮轮询窗口内」，配合按天去重，既不会漏也不会重。
 */
function fromDigests(options: BuildPlanOptions): PlannedNotification[] {
  const { tasks, config, now } = options;
  const timeZone = config.timezone;
  const parts = getZonedParts(now, timeZone);
  const windowMs = config.pollIntervalSeconds * 1000;
  const payload = buildDigestPayload(tasks, now, timeZone);

  const rules = [
    { kind: 'digest-morning', event: 'digest_morning', rule: config.officialRules.digest.morning },
    { kind: 'digest-evening', event: 'digest_evening', rule: config.officialRules.digest.evening },
    { kind: 'digest-weekly', event: 'digest_weekly', rule: config.officialRules.digest.weekly },
  ];

  const result: PlannedNotification[] = [];
  for (const item of rules) {
    if (!item.rule.enabled) continue;
    // 每周回顾额外要求星期匹配（默认周日）。
    if (item.rule.day !== undefined && parts.weekday !== item.rule.day) continue;

    const hm = parseHm(item.rule.at);
    const scheduledAt = zonedTimeToEpoch(parts.dateKey, hm.hour, hm.minute, timeZone);
    if (now < scheduledAt || now - scheduledAt >= windowMs) continue;

    result.push({
      event: item.event,
      kind: item.kind,
      scheduledAt,
      // BASE-29：摘要去重键是 kind + 日期，morning/evening 必须分开。
      dedupeKey: `${item.kind}:${parts.dateKey}`,
      digest: payload,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 四、A 类扩展（EXT-16 / 17 / 18），默认关闭
// ---------------------------------------------------------------------------

/**
 * EXT-16【官方无】：仅日期任务当日汇总提醒。
 * 判定严格复用官方 hasTimeComponent，false 才算仅日期；T00:00 不算。
 * 汇总成一条而不是逐条发，避免启动时集中轰炸。
 */
function fromDateOnly(options: BuildPlanOptions): PlannedNotification[] {
  const { tasks, config, now } = options;
  const rule = config.enhancements.triggers.dateOnly;
  if (!rule.enabled) return [];

  const dateOnlyTasks = tasks.filter(task => task.dueDate && !hasTimeComponent(task.dueDate));
  if (!dateOnlyTasks.length) return [];

  const parts = getZonedParts(now, config.timezone);
  const hm = parseHm(rule.at);
  const scheduledAt = zonedTimeToEpoch(parts.dateKey, hm.hour, hm.minute, config.timezone);
  if (now < scheduledAt || now - scheduledAt >= config.pollIntervalSeconds * 1000) return [];

  return [{
    event: 'date_only',
    kind: 'date-only',
    scheduledAt,
    dedupeKey: `date-only:${parts.dateKey}`,
    digest: {
      dueToday: dateOnlyTasks.map(summarizeTask),
      overdue: [], startingToday: [], focused: [],
    },
  }];
}

/**
 * EXT-17【官方无】：积压逾期汇总，节流防重启骚扰。
 * 节流靠 StateStore 的元数据，由 Scheduler 在投递成功后写入；这里只读不写。
 */
function fromBacklog(options: BuildPlanOptions): PlannedNotification[] {
  const { tasks, config, now, store } = options;
  const rule = config.enhancements.triggers.backlog;
  if (!rule.enabled) return [];

  const lastRaw = store.getMeta('last_backlog_at');
  const last = lastRaw ? Number(lastRaw) : 0;
  if (last && now - last < rule.minIntervalMs) return [];

  const today = getZonedParts(now, config.timezone).dateKey;
  const overdue = tasks.filter(task => {
    const dueAt = parseTaskDate(task.dueDate);
    return dueAt !== null && localDateKey(dueAt, config.timezone) < today;
  });
  if (!overdue.length) return [];

  return [{
    event: 'backlog',
    kind: 'backlog',
    scheduledAt: now,
    dedupeKey: `backlog:${today}`,
    backlog: { count: overdue.length, tasks: overdue.map(summarizeTask) },
  }];
}

/**
 * 判断静默窗口并给出顺延后的时刻（EXT-18）。
 * 支持跨午夜（如 23:00–08:00）；解禁后只发一条最新状态，不叠加补发。
 */
function deferQuietHour(scheduledAt: number, start: string, end: string, timeZone: string): number {
  const parts = getZonedParts(scheduledAt, timeZone);
  const startHm = parseHm(start);
  const endHm = parseHm(end);
  const windowStart = zonedTimeToEpoch(parts.dateKey, startHm.hour, startHm.minute, timeZone);
  const windowEndSameDay = zonedTimeToEpoch(parts.dateKey, endHm.hour, endHm.minute, timeZone);
  const crossesMidnight = windowEndSameDay <= windowStart;

  if (!crossesMidnight) {
    return scheduledAt >= windowStart && scheduledAt < windowEndSameDay
      ? windowEndSameDay
      : scheduledAt;
  }
  // 跨午夜：晚间段顺延到次日 end，凌晨段顺延到当天 end。
  if (scheduledAt >= windowStart) return windowEndSameDay + DAY_MS;
  if (scheduledAt < windowEndSameDay) return windowEndSameDay;
  return scheduledAt;
}

/** 静默时段统一后处理：只改 scheduledAt，不改去重键，避免解禁后重复投递。 */
function applyQuietHours(plan: PlannedNotification[], options: BuildPlanOptions): void {
  const rule = options.config.enhancements.triggers.quietHours;
  if (!rule.enabled || !rule.defer) return;
  for (const item of plan) {
    item.scheduledAt = deferQuietHour(item.scheduledAt, rule.start, rule.end, options.config.timezone);
  }
}

// ---------------------------------------------------------------------------
// 五、统一入口
// ---------------------------------------------------------------------------

/**
 * 生成本轮完整的提醒计划，按时间升序。
 * strict=true 时 A 类扩展一律不参与，输出可与官方算法做集合比对。
 */
export function buildPlan(options: BuildPlanOptions): PlannedNotification[] {
  // 任务级与摘要属于【一致】基线，任何模式下都生成。
  // 任务级与项目回顾同属 BASE 基线，strict 下也必须生成。
  const plan = [...fromTaskTriggers(options), ...fromProjectReviews(options), ...fromDigests(options)];

  if (!options.strict) {
    plan.push(...fromDateOnly(options));
    plan.push(...fromBacklog(options));
    applyQuietHours(plan, options);
  }

  return plan.sort((left, right) => left.scheduledAt - right.scheduledAt);
}
