/**
 * 提醒触发计划 —— M1 的核心，全部是纯函数
 *
 * 这个文件负责回答两个问题：「要不要发」和「什么时候发」。
 * 它不做任何网络请求、不读写数据库、不碰配置，因此可以用同一份任务数据
 * 与官方 getTaskReminderPlan 的输出做集合比对（spec §18 的验收方法）。
 *
 * 规则来源（逐条标注编号，细节见 spec §15 清单 A）：
 *   BASE-12  字段合法值          BASE-16/17  发送策略与默认值继承
 *   BASE-18  skip 语义           BASE-19     单一策略与提前量抑制
 *   BASE-21  带时间判定          BASE-22     仅日期不排提醒
 *   BASE-23  提前量日历日算术    BASE-25     重复提醒次数公式
 *   BASE-28  活跃范围与归档项目过滤
 *
 * 设计边界：A 类扩展（EXT-16 仅日期任务 09:00 等）不写在这里，
 * 由上层插件叠加，保证 strict 模式下的基线是纯净的。
 */

import type {
  EffectivePolicy,
  MindwtrProject,
  MindwtrTask,
  ReminderKind,
  ReminderPlanOptions,
  ReminderTrigger,
  TaskReminderDefault,
} from '../types.ts';

// ---------------------------------------------------------------------------
// 常量：全部来自官方源码，不要凭印象改数字
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

/** dueReminderLeadMinutes 合法范围 0–10080（分钟），UI 预设是其中的几个值（BASE-12）。 */
const DUE_LEAD_MAX_MINUTES = 10_080;

/** startReminderLeadMinutes 只接受这几个值（BASE-12）。 */
const VALID_START_LEADS: readonly number[] = [0, 5, 15, 30, 60];

/** repeatReminderMinutes 只接受这几个值（BASE-12）。 */
const VALID_REPEAT_INTERVALS: readonly number[] = [5, 10, 15, 30, 60];

/** 重复提醒的窗口与次数上限（BASE-25）。 */
const REPEAT_WINDOW_MINUTES = 120;
const REPEAT_MAX_OCCURRENCES = 8;

/** isTaskActionable 认可的活跃状态（BASE-28）。 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['inbox', 'next', 'waiting', 'someday']);

/** 官方 date.ts 的 hasTimeComponent 正则，逐字复用（BASE-21）。 */
const HAS_TIME_COMPONENT = /[T\s]\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// 字段规范化
// ---------------------------------------------------------------------------

/**
 * 判断日期字符串是否带「时间部分」（BASE-21）。
 *
 * 不要改成 Date.parse 之类：官方用的是这条正则，语义差别很大——
 *   "2026-11-13"        → false（仅日期，所有任务级提醒都不排）
 *   "2026-11-13T00:00"  → true （午夜也算带时间，是最容易误判的一条）
 *   "2026-11-13 09:30"  → true
 */
export function hasTimeComponent(value: unknown): boolean {
  return typeof value === 'string' && HAS_TIME_COMPONENT.test(value);
}

/**
 * 把提前量 / 重复间隔规范化；非法值一律按「未设置」返回 null。
 * 对齐官方 normalize* 函数（BASE-12）：客户端版本不一致时可能传来奇怪的值，
 * 宁可当作没设，也不要算出一个不存在的提醒时刻。
 */
export function normalizeDueLeadMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 0 && value <= DUE_LEAD_MAX_MINUTES ? value : null;
}

export function normalizeStartLeadMinutes(value: unknown): number | null {
  return typeof value === 'number' && VALID_START_LEADS.includes(value) ? value : null;
}

export function normalizeRepeatMinutes(value: unknown): number | null {
  return typeof value === 'number' && VALID_REPEAT_INTERVALS.includes(value) ? value : null;
}

// ---------------------------------------------------------------------------
// 时间计算
// ---------------------------------------------------------------------------

/**
 * 计算截止重复提醒的各个触发时刻（BASE-25）。
 *
 * 次数 = min(8, floor(120 / interval))，不是固定 8 次：
 * 间隔 5/10/15 分 → 8 次，30 分 → 4 次，60 分 → 2 次。
 * 关掉重复提醒（字段不存在）时返回空数组，首次截止提醒仍由上層照常发出。
 */
export function getDueRepeatTimes(dueAt: number, intervalMinutes: number): number[] {
  const interval = normalizeRepeatMinutes(intervalMinutes);
  if (interval === null) return [];

  const count = Math.min(REPEAT_MAX_OCCURRENCES, Math.floor(REPEAT_WINDOW_MINUTES / interval));
  const times: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    times.push(dueAt + index * interval * MINUTE_MS);
  }
  return times;
}

/**
 * 按提前量回退触发时刻（BASE-23）。
 *
 * 提前量是整天（1440 的倍数）时必须按「日历日」回退，不能简单减毫秒：
 * 夏令时切换前后减 24 小时会让本地时刻漂移一小时，按日历日回退则保持同一本地时刻。
 * 分钟级提前量直接减毫秒即可。
 *
 * 实现说明：这里用 UTC 日历日做减法，在 UTC 环境下等价于官方的 setDate。
 * 若配置 timezone 不是 UTC，跨 DST 的严格对齐需要 M2 引入时区计算后补齐；
 * 分钟级提前量不受影响，已在单元测试中固定。
 */
export function subtractLeadTime(instant: number, leadMinutes: number): number {
  if (leadMinutes % MINUTES_PER_DAY === 0) {
    const days = leadMinutes / MINUTES_PER_DAY;
    const date = new Date(instant);
    date.setUTCDate(date.getUTCDate() - days);
    return date.getTime();
  }
  return instant - leadMinutes * MINUTE_MS;
}

// ---------------------------------------------------------------------------
// 发送策略
// ---------------------------------------------------------------------------

/**
 * 解析任务的有效发送策略（BASE-16 / BASE-17）。
 *
 * 优先级：显式 reminderPolicy > 旧字段 suppressMindwtrReminders 回退 > 默认 send。
 * 只有取值为 inherit 时才跟随全局默认；字段整个缺失时是 send，不是跟随全局默认——
 * 这一区别在旧版客户端（≤1.3.6）上尤其重要。
 */
export function getTaskReminderPolicy(
  task: MindwtrTask,
  globalDefault: TaskReminderDefault = 'send',
): EffectivePolicy {
  const raw = task.reminderPolicy;

  if (raw === 'send' || raw === 'skip' || raw === 'start' || raw === 'due') return raw;
  if (raw === 'inherit') return globalDefault;

  // 没有 reminderPolicy 时，旧版用这个布尔表达「跳过」。
  if (task.suppressMindwtrReminders === true) return 'skip';

  return 'send';
}

/**
 * 判断某个 kind 是否应该发送（BASE-18 / BASE-19）。
 *
 * - 摘要由独立开关控制，不进入任务策略判断；
 * - skip 撤销 start/due 及重复提醒，但 review 仍会触发（BASE-18 最易写错的一条）；
 * - start / due 单一策略只发对应那一类；若配置了提前量，普通的 start/due
 *   提醒被抑制，只发提前那一条（BASE-19）。
 *
 * 存疑点：设置了 due 提前量且策略为 due 时，due-repeat 是否仍发送，
 * 官方源码未完全确认；此处按「只发提前那一条」的字面语义实现，M2 用真实数据复测。
 */
export function shouldSendReminderKind(
  policy: EffectivePolicy,
  kind: ReminderKind,
  options: { startLeadConfigured?: boolean; dueLeadConfigured?: boolean } = {},
): boolean {
  // 摘要不受任务策略影响（由独立开关控制）
  if (kind.startsWith('digest-')) return true;

  // review / project-review 独立于任务策略，仅受设备级开关控制（BASE-06 / BASE-18，对齐官方）：
  // 官方 getNextTaskReminderIntent 的 review 候选只判 includeReviewAt，不判 reminderPolicy，
  // 因此 start / due 单一策略下 review 仍会触发，skip 也仍会触发。
  if (kind === 'review' || kind === 'project-review') return true;

  // skip：撤销 start / due 及其提前与重复，但 review 已在上面放行（BASE-18）
  if (policy === 'skip') return false;

  if (policy === 'start') {
    // 单一 start 策略：只发开始类；配了提前量时普通 start 被抑制（BASE-19）
    if (options.startLeadConfigured) return kind === 'start-advance';
    return kind === 'start' || kind === 'start-advance';
  }

  if (policy === 'due') {
    // 单一 due 策略：只发截止类；配了提前量时普通 due 被抑制（BASE-19）。
    // 注意：单一策略下不排 due-repeat（官方 getDueReminderRepeatTimes 的 isSingleTaskReminder 抑制），
    // 故这里不含 'due-repeat'。
    if (options.dueLeadConfigured) return kind === 'due-advance';
    return kind === 'due' || kind === 'due-advance';
  }

  return true; // send：任务级提醒全部发送
}

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

/**
 * 任务是否参与提醒调度（BASE-28）。
 * 活跃状态只有四个；已完成、已取消、已删除的任务一律排除。
 */
export function isTaskActionable(task: MindwtrTask): boolean {
  if (!ACTIVE_STATUSES.has(task.status)) return false;
  if (task.deletedAt || task.completedAt || task.cancelledAt) return false;
  if (task.archivedAt) return false;
  return true;
}

/**
 * 任务是否属于已归档 / 已删除的项目（BASE-28）。
 *
 * 实测本实例的项目列表没有 archivedAt / deletedAt，但有 status，
 * 因此优先用任务级 projectArchivedAt，再回退项目状态。
 * 项目缓存查不到时「保守放行」——宁可多提醒一条，也不要漏掉真实待办。
 */
export function isTaskInArchivedProject(
  task: MindwtrTask,
  projects: ReadonlyMap<string, MindwtrProject>,
): boolean {
  if (task.projectArchivedAt) return true;
  if (!task.projectId) return false;

  const project = projects.get(task.projectId);
  if (!project) return false; // 缓存不可用，保守放行

  return project.status === 'archived' || Boolean(project.deletedAt);
}

// ---------------------------------------------------------------------------
// 触发计划
// ---------------------------------------------------------------------------

/**
 * 计算一条任务的全部触发点（M1 核心，与官方同名便于验收比对）。
 *
 * 输入是单条任务，输出按时间升序的触发点数组；不做 IO，结果只由输入决定。
 * 仅日期任务（hasTimeComponent=false）在这里不产生任何任务级触发点（BASE-22），
 * A 类扩展的「当天 09:00」由上层插件追加，不会污染 strict 基线。
 */
export function getTaskReminderPlan(
  task: MindwtrTask,
  options: ReminderPlanOptions = {},
): ReminderTrigger[] {
  if (!isTaskActionable(task)) return [];

  const policy = getTaskReminderPolicy(task, options.globalDefault ?? 'send');
  const dueLead = normalizeDueLeadMinutes(task.dueReminderLeadMinutes);
  const startLead = normalizeStartLeadMinutes(task.startReminderLeadMinutes);
  const repeatInterval = normalizeRepeatMinutes(task.repeatReminderMinutes);

  // 提前量是否「配置了」：0 表示关闭，不能算作已配置。
  const strategyOptions = {
    startLeadConfigured: Boolean(startLead && startLead > 0),
    dueLeadConfigured: Boolean(dueLead && dueLead > 0),
  };

  const includeStart = options.includeStart ?? true;
  const includeDue = options.includeDue ?? true;
  const includeReview = options.includeReview ?? true;

  const triggers: ReminderTrigger[] = [];

  /** 统一入口：先过策略闸门，再记录触发点，避免每个分支重复写判断。 */
  const push = (kind: ReminderKind, at: number, extra: Partial<ReminderTrigger> = {}): void => {
    if (!Number.isFinite(at)) return;
    if (!shouldSendReminderKind(policy, kind, strategyOptions)) return;
    triggers.push({ kind, taskId: task.id, scheduledAt: at, ...extra });
  };

  // 截止类：due / due-advance / due-repeat
  if (includeDue && hasTimeComponent(task.dueDate)) {
    const dueAt = Date.parse(String(task.dueDate));
    if (Number.isFinite(dueAt)) {
      push('due', dueAt);
      if (dueLead && dueLead > 0) {
        push('due-advance', subtractLeadTime(dueAt, dueLead), { leadMinutes: dueLead });
      }
      if (repeatInterval !== null) {
        getDueRepeatTimes(dueAt, repeatInterval).forEach((at, index) => {
          push('due-repeat', at, { repeatIndex: index + 1 });
        });
      }
    }
  }

  // 开始类：start / start-advance
  if (includeStart && hasTimeComponent(task.startTime)) {
    const startAt = Date.parse(String(task.startTime));
    if (Number.isFinite(startAt)) {
      push('start', startAt);
      if (startLead && startLead > 0) {
        push('start-advance', subtractLeadTime(startAt, startLead), { leadMinutes: startLead });
      }
    }
  }

  // 回顾：独立于任务策略（BASE-06 / BASE-18，对齐官方），仅受设备级开关控制（BASE-20）。
  // 即便 reminderPolicy 为 start / due / skip，review 仍会触发。
  if (includeReview && hasTimeComponent(task.reviewAt)) {
    push('review', Date.parse(String(task.reviewAt)));
  }

  return triggers.sort((left, right) => left.scheduledAt - right.scheduledAt);
}
