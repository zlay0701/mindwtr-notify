/**
 * Notify 的共享类型定义
 *
 * 字段来源有两处：
 *   1. docs/probe-result.md —— 对你自托管实例的实测结果；
 *   2. Mindwtr 官方 packages/core/src/task-sync-schema.ts —— 源码声明的字段。
 *
 * 重要：Cloud API 的字段是「条件性」的。任务没设截止时间时，dueDate 这个 key
 * 根本不会出现在响应里（实测 595 条活跃任务无一含 dueDate）。因此除 id / status
 * 等少数必备字段外一律声明为可选，访问前必须判空，不能假设它存在。
 */

/** 任务状态。BASE-28 只把前四种视为「活跃」；用 string 以兼容未来新增状态。 */
export type TaskStatus =
  | 'inbox' | 'next' | 'waiting' | 'someday'
  | 'done' | 'archived' | 'reference'
  | string;

/** reminderPolicy 的五态（BASE-16）。旧版没有该字段时用 suppressMindwtrReminders 回退。 */
export type ReminderPolicy = 'inherit' | 'send' | 'skip' | 'start' | 'due';

/** 去掉 inherit 之后的「有效策略」——inherit 会先被解析成全局默认值。 */
export type EffectivePolicy = Exclude<ReminderPolicy, 'inherit'>;

/** 全局默认发送策略，对应设置里的 taskReminderDefault（BASE-17）。 */
export type TaskReminderDefault = 'send' | 'skip';

/** Cloud API 返回的任务。 */
export interface MindwtrTask {
  id: string;
  status: TaskStatus;
  title?: string;
  description?: string;

  /** 同步修订号；同一任务出现在多页时按 rev 取新（EXT-09）。 */
  rev?: number;

  // ---- 三类时间字段：只有明确设置过才会出现 ----
  dueDate?: string;
  startTime?: string;
  reviewAt?: string;

  // ---- 提醒参数：随任务同步，本服务只读 ----
  dueReminderLeadMinutes?: number;
  startReminderLeadMinutes?: number;
  repeatReminderMinutes?: number;
  reminderPolicy?: ReminderPolicy;

  /** 旧版跳过字段；reminderPolicy 缺失且它为 true 时等价于 skip（BASE-16）。 */
  suppressMindwtrReminders?: boolean;

  // ---- 过滤用字段 ----
  completedAt?: string;
  /** status=archived 且带此字段 = 已取消，无 completedAt、不生成下一次重复（BASE-13）。 */
  cancelledAt?: string;
  deletedAt?: string;
  archivedAt?: string;
  /** 所属项目的归档时间，可直接用于归档项目过滤（BASE-28）；本实例暂无样本。 */
  projectArchivedAt?: string;
  projectId?: string;

  /** 允许 API 返回未来新增的字段，避免解析时报错。 */
  [key: string]: unknown;
}

/** 项目。实测列表含 status / title / rev / isFocused 等，未见 reviewAt / archivedAt。 */
export interface MindwtrProject {
  id: string;
  title?: string;
  status?: string;
  rev?: number;
  isFocused?: boolean;

  /** 项目回顾日期（BASE-07）。当前实例未见样本，仍按官方 schema 保留。 */
  reviewAt?: string;
  deletedAt?: string;

  [key: string]: unknown;
}

/** 提醒类型，与 spec §15 的触发类型一一对应。 */
export type ReminderKind =
  | 'start' | 'start-advance'
  | 'due' | 'due-advance' | 'due-repeat'
  | 'review' | 'project-review'
  | 'digest-morning' | 'digest-evening' | 'digest-weekly';

/**
 * 一个待触发的提醒点。
 * Scheduler 只按 scheduledAt 投递，不在这里重新做策略判断，
 * 这样「要不要发」和「什么时候发」可以独立测试。
 */
export interface ReminderTrigger {
  kind: ReminderKind;
  taskId?: string;
  projectId?: string;

  /** UTC 时间戳（毫秒）。全局统一用 UTC 存储，展示时再按配置时区渲染。 */
  scheduledAt: number;

  /** 提前量（分钟），仅 advance 类有值。 */
  leadMinutes?: number;

  /** 第几次重复提醒，仅 due-repeat 有值，用于生成去重键 `${dueDate}#${index+1}`。 */
  repeatIndex?: number;
}

/** 计算触发点时的可选项，对应官方的全局默认值与设备级开关。 */
export interface ReminderPlanOptions {
  /** 全局默认策略（BASE-17），默认 send。 */
  globalDefault?: TaskReminderDefault;

  /** 设备级四类开关中的三个（BASE-20），默认全开。 */
  includeStart?: boolean;
  includeDue?: boolean;
  includeReview?: boolean;
}
