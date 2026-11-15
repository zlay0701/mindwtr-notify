/**
 * 黄金基准：官方 Mindwtr schedule-utils.ts 的逐字移植
 *
 * 来源：github.com/dongdongbh/Mindwtr · packages/core/src/schedule-utils.ts
 *       ＋ 其依赖 date.ts / due-reminder-lead.ts / task-status.ts / task-reminder-policy.ts
 *
 * 用途（目标 A / spec §18.2）：把官方规则作为基准，与 Notify 的 getTaskReminderPlan 用同一份任务数据
 * 跑 (task_id, kind, scheduledAt) 集合比对，strict 模式差集必须为空。
 *
 * 移植约定：
 *   - 仅保留 getTaskReminderPlan 比较所需的函数，逻辑与常量逐字保留；
 *   - date-fns 的 isAfter / isValid / parseISO 用原生等价替代（语义一致）；
 *   - 本文件零运行时依赖，Node 原生类型剥离即可运行；
 *   - 不引入任何 Notify 自身代码，确保这是「独立第三方基准」，而非把 Notify 再抄一遍。
 *
 * 与官方 getTaskReminderPlan 的唯一偏离见 officialGetTaskReminderPlanTuples 的注释：
 * 官方返回 next = start/due/review 中最早的一个（运行时「下一个该响」的优化），但随生命周期三者都会被排定；
 * 这里把三者全部展开，才能与 Notify 一次性输出全部触发点的语义做集合比对。
 */

import type { MindwtrTask } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 依赖：date.ts —— hasTimeComponent / safeParseDate
// ---------------------------------------------------------------------------

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const max = month === 2 && isGregorianLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= max;
}

/** 原生等价 date-fns 的 isValid：非法日期构造出 Invalid Date，getTime() 为 NaN。 */
function isValid(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/** 官方 date.ts 的 hasTimeComponent，逐字复用（BASE-21）。 */
export function hasTimeComponent(dateStr: string | undefined | null): boolean {
  if (!dateStr) return false;
  return /[T\s]\d{2}:\d{2}/.test(dateStr);
}

/** 官方 date.ts 的 safeParseDate，逐字复用（仅把 date-fns 的 parseISO/isValid 换成原生）。 */
export function safeParseDate(dateStr: string | undefined | null): Date | null {
  if (!dateStr) return null;
  try {
    const instantMatch = ISO_INSTANT_PATTERN.exec(dateStr);
    if (
      instantMatch &&
      isValidCalendarDate(Number(instantMatch[1]), Number(instantMatch[2]), Number(instantMatch[3]))
    ) {
      const parsed = Date.parse(dateStr);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
    const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(dateStr);
    if (!hasTimezone) {
      const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?$/.exec(
          dateStr,
        );
      if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        const day = Number(match[3]);
        if (!isValidCalendarDate(year, month + 1, day)) return null;
        const hour = match[4] ? Number(match[4]) : 0;
        const minute = match[5] ? Number(match[5]) : 0;
        const second = match[6] ? Number(match[6]) : 0;
        const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
        const localDate =
          year >= 0 && year <= 99
            ? (() => {
                const d = new Date(2000, month, day, hour, minute, second, ms);
                d.setFullYear(year);
                return d;
              })()
            : new Date(year, month, day, hour, minute, second, ms);
        return isValid(localDate) ? localDate : null;
      }
    }
    const date = new Date(dateStr);
    return isValid(date) ? date : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 依赖：due-reminder-lead.ts —— 提前量规范化
// ---------------------------------------------------------------------------

/** 官方 normalizeDueReminderLeadMinutes，逐字复用（BASE-12：0–10080）。 */
function normalizeDueReminderLeadMinutes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_080
    ? value
    : undefined;
}

/** 官方 normalizeStartReminderLeadMinutes，逐字复用（BASE-12：仅 0/5/15/30/60）。 */
function normalizeStartReminderLeadMinutes(value: unknown): number | undefined {
  const minutes = normalizeDueReminderLeadMinutes(value);
  return minutes === 0 || minutes === 5 || minutes === 15 || minutes === 30 || minutes === 60
    ? minutes
    : undefined;
}

// ---------------------------------------------------------------------------
// 依赖：schedule-utils.ts —— 重复间隔规范化与本文件使用的常量
// ---------------------------------------------------------------------------

const REPEAT_REMINDER_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
const REPEAT_REMINDER_MAX_WINDOW_MINUTES = 120;
const REPEAT_REMINDER_MAX_OCCURRENCES = 8;
const REPEAT_REMINDER_INTERVAL_SET: ReadonlySet<number> = new Set(REPEAT_REMINDER_INTERVAL_OPTIONS);

/** 官方 normalizeRepeatReminderMinutes，逐字复用（BASE-12：仅 5/10/15/30/60）。 */
function normalizeRepeatReminderMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return REPEAT_REMINDER_INTERVAL_SET.has(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// 依赖：task-status.ts —— 活跃判定
// ---------------------------------------------------------------------------

/** 官方 isTaskActionable，逐字复用（BASE-28：排除 done / archived / reference）。 */
function isTaskActionable(status: string | undefined): boolean {
  return status !== 'done' && status !== 'archived' && status !== 'reference';
}

// ---------------------------------------------------------------------------
// 依赖：task-reminder-policy.ts —— 策略解析与判定
// ---------------------------------------------------------------------------

type OfficialPolicy = 'inherit' | 'send' | 'skip' | 'start' | 'due';

/** 官方 normalizeTaskReminderPolicy。 */
function normalizeTaskReminderPolicy(value: unknown): OfficialPolicy | undefined {
  return value === 'inherit' || value === 'send' || value === 'skip' || value === 'start' || value === 'due'
    ? value
    : undefined;
}

/** 官方 getTaskReminderPolicy，逐字复用（BASE-16：显式值 > 旧字段回退 > 默认 send）。 */
function getTaskReminderPolicy(task: MindwtrTask): OfficialPolicy {
  const policy = normalizeTaskReminderPolicy(task.reminderPolicy);
  if (policy) return policy;
  return task.suppressMindwtrReminders === true ? 'skip' : 'send';
}

/** 官方 shouldSendTaskReminders（inherit 在此处解析为全局默认）。 */
function shouldSendTaskReminders(
  task: MindwtrTask,
  settings: { taskReminderDefault?: 'send' | 'skip' },
): boolean {
  const policy = getTaskReminderPolicy(task);
  return policy === 'inherit' ? settings.taskReminderDefault !== 'skip' : policy !== 'skip';
}

/** 官方 isSingleTaskReminder：start / due 单一策略。 */
function isSingleTaskReminder(task: MindwtrTask): boolean {
  const policy = getTaskReminderPolicy(task);
  return policy === 'start' || policy === 'due';
}

/** 官方 shouldSendTaskReminderKind（仅用于 start / due 的判定）。 */
function shouldSendTaskReminderKind(
  task: MindwtrTask,
  kind: 'start' | 'due',
  settings: { taskReminderDefault?: 'send' | 'skip' },
): boolean {
  return (
    shouldSendTaskReminders(task, settings) &&
    (!isSingleTaskReminder(task) || getTaskReminderPolicy(task) === kind)
  );
}

// ---------------------------------------------------------------------------
// 依赖：schedule-utils.ts —— 触发点计算核心
// ---------------------------------------------------------------------------

/** 原生等价 date-fns 的 isAfter。 */
function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

/** 官方 parseExplicitReminderDate：无时间部分即返回 null（BASE-22）。 */
function parseExplicitReminderDate(value: string | undefined | null): Date | null {
  if (!hasTimeComponent(value ?? undefined)) return null;
  return safeParseDate(value ?? undefined);
}

/** 官方 isInactiveTask：deletedAt 或不可活跃即非活跃。 */
function isInactiveTask(task: MindwtrTask): boolean {
  return Boolean(task.deletedAt) || !isTaskActionable(task.status);
}

/** 官方 getDueReminderRepeatTimes：重复提醒次数 min(8, floor(120/interval))（BASE-25）。 */
function getDueReminderRepeatTimes(
  task: MindwtrTask,
  options: ScheduleOptions,
): Date[] {
  if (isInactiveTask(task)) return [];
  // 单一策略（start/due）或全局关闭时不排重复提醒；与 BASE-19 单一策略语义一致
  if (!shouldSendTaskReminders(task, options) || isSingleTaskReminder(task)) return [];
  if (options.includeDueDate === false) return [];
  const interval = normalizeRepeatReminderMinutes(task.repeatReminderMinutes);
  if (!interval) return [];
  const due = parseExplicitReminderDate(task.dueDate);
  if (!due) return [];
  const count = Math.min(
    REPEAT_REMINDER_MAX_OCCURRENCES,
    Math.floor(REPEAT_REMINDER_MAX_WINDOW_MINUTES / interval),
  );
  const times: Date[] = [];
  for (let i = 1; i <= count; i += 1) {
    times.push(new Date(due.getTime() + i * interval * 60_000));
  }
  return times;
}

/** 官方 getDueAdvanceReminderIntent：due-advance（BASE-04 / BASE-23 日历日回退）。 */
function getDueAdvanceReminderIntent(
  task: MindwtrTask,
  now: Date,
  options: ScheduleOptions,
): { kind: 'due-advance'; scheduledAt: Date } | null {
  if (isInactiveTask(task) || !shouldSendTaskReminderKind(task, 'due', options) || options.includeDueDate === false)
    return null;
  const lead = normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes);
  const due = parseExplicitReminderDate(task.dueDate);
  if (!lead || !due) return null;
  const scheduledAt = new Date(due);
  // 官方用本地 setDate 做日历日回退；本文件在 UTC 下运行，本地 == UTC，与 Notify 的 setUTCDate 完全一致
  if (lead % 1440 === 0) scheduledAt.setDate(scheduledAt.getDate() - lead / 1440);
  else scheduledAt.setTime(scheduledAt.getTime() - lead * 60_000);
  if (!isAfter(scheduledAt, now)) return null;
  return { kind: 'due-advance', scheduledAt };
}

/** 官方 getStartAdvanceReminderIntent：start-advance（BASE-02；注意官方始终按分钟减，不做日历日）。 */
function getStartAdvanceReminderIntent(
  task: MindwtrTask,
  now: Date,
  options: ScheduleOptions,
): { kind: 'start-advance'; scheduledAt: Date } | null {
  const lead = normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes);
  if (!lead || isInactiveTask(task) || !shouldSendTaskReminderKind(task, 'start', options) || options.includeStartTime === false)
    return null;
  const start = parseExplicitReminderDate(task.startTime);
  if (!start) return null;
  // 官方 start-advance 始终按分钟回退（与 due-advance 不同）
  const scheduledAt = new Date(start.getTime() - lead * 60_000);
  if (!isAfter(scheduledAt, now)) return null;
  return { kind: 'start-advance', scheduledAt };
}

/** 官方 getNextTaskReminderIntent 里的三个候选（start / due / review）。 */
function getCandidateKinds(task: MindwtrTask, options: ScheduleOptions): Array<'start' | 'due' | 'review'> {
  // 官方 getNextTaskReminderIntent 开头即 isInactiveTask 守卫；非活跃任务不排任何候选
  if (isInactiveTask(task)) return [];
  const kinds: Array<'start' | 'due' | 'review'> = [];
  const startLead = normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes);
  const dueLead = normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes);

  if (
    shouldSendTaskReminderKind(task, 'start', options) &&
    options.includeStartTime !== false &&
    !(isSingleTaskReminder(task) && startLead)
  ) {
    kinds.push('start');
  }
  if (
    shouldSendTaskReminderKind(task, 'due', options) &&
    options.includeDueDate !== false &&
    !(isSingleTaskReminder(task) && dueLead)
  ) {
    kinds.push('due');
  }
  // 官方 review 候选仅受 includeReviewAt 控制，与任务策略无关（BASE-06 / BASE-18）
  if (options.includeReviewAt === true) {
    kinds.push('review');
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// 对外：基准入口
// ---------------------------------------------------------------------------

export interface ScheduleOptions {
  includeStartTime?: boolean;
  includeDueDate?: boolean;
  includeReviewAt?: boolean;
  taskReminderDefault?: 'send' | 'skip';
}

/** 一条待比对的触发点元组。 */
export interface TriggerTuple {
  taskId: string;
  kind: string;
  scheduledAt: number;
}

/**
 * 黄金基准入口：用官方逐字移植的判定 / 时间算法，枚举一条任务「在生命周期内会被排定的全部触发点」。
 *
 * 与官方 getTaskReminderPlan 的唯一偏离：官方返回 next = start/due/review 中最早的一个
 * （运行时「下一个该响」的优化），但官方在响完后会重算并依次响其余——三者集合本应都被排定。
 * 这里把三者全部展开，才能与 Notify 一次性输出全部触发点的语义做集合比对。
 *
 * now 固定为 1970，使 isAfter 恒为真，中和官方「仅未来」过滤（该过滤由 Notify 的 Scheduler 在投递时承担）。
 * 这样比较的是「纯粹的时间计算 + 策略门控」一致性，与具体运行时刻无关。
 */
export function officialGetTaskReminderPlanTuples(
  task: MindwtrTask,
  options: ScheduleOptions = {},
): TriggerTuple[] {
  const now = new Date(0);
  const tuples: TriggerTuple[] = [];

  const push = (kind: string, scheduledAt: Date | null): void => {
    if (!scheduledAt || !Number.isFinite(scheduledAt.getTime())) return;
    tuples.push({ taskId: task.id, kind, scheduledAt: scheduledAt.getTime() });
  };

  // 1) due-repeat（始终按官方公式，单一策略下本身返回空）
  getDueReminderRepeatTimes(task, options).forEach((at) => push('due-repeat', at));

  // 2) start / due / review 三个候选全部展开（替代官方的 [0] 选择）
  for (const kind of getCandidateKinds(task, options)) {
    const value = kind === 'start' ? task.startTime : kind === 'due' ? task.dueDate : task.reviewAt;
    push(kind, parseExplicitReminderDate(value));
  }

  // 3) advance / startAdvance
  const advance = getDueAdvanceReminderIntent(task, now, options);
  if (advance) push('due-advance', advance.scheduledAt);
  const startAdvance = getStartAdvanceReminderIntent(task, now, options);
  if (startAdvance) push('start-advance', startAdvance.scheduledAt);

  return tuples;
}
