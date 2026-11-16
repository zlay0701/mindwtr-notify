/**
 * 消息渲染（EXT-02【增强】结构化消息、EXT-03【官方无】数据最小化）
 *
 * 外发内容规则：
 *   - 单任务提醒带去 Markdown 的 description（BASE-15 与官方一致）；
 *   - 摘要 / backlog 等汇总类不带描述；
 *   - 任何消息都不含 attachments / assignedTo / contexts / tags。
 *
 * 这个文件只负责「把计划项变成消息」，不负责发送，方便单独测试内容边界。
 */

import type { NotifyConfig } from '../config.ts';
import { formatStamp, type TimeFormatOptions } from '../format.ts';
import type { PlannedNotification, TaskSummary } from '../rules/plan.ts';

/** 邮件内容。SMTP 传输层只认这个结构，不关心它从哪来。 */
export interface EmailContent {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface NotifyMessage {
  event: string;
  task?: {
    id: string;
    title: string;
    status: string;
    dueDate?: string;
    startTime?: string;
    reviewAt?: string;
    projectId?: string;
    projectName?: string;
    description?: string;
  };
  trigger?: PlannedNotification['trigger'];
  /** 项目回顾（BASE-07）用：只带 id 与标题。 */
  project?: { id: string; title?: string };
  digest?: PlannedNotification['digest'];
  backlog?: PlannedNotification['backlog'];
  /** 系统告警正文（M3：平台适配器需要把告警内容显示出来）。 */
  note?: string;
  sentAt: string;
}

/** 去掉 Markdown 标记，让邮件与 Webhook 里显示纯文本描述。 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 渲染结构化消息。
 *
 * 刻意**不生成任何「打开链接」**（v1.22 起）：Mindwtr Cloud 没有可直接打开的
 * Web 端任务页，拼出来的 `/#/task/<id>` 在接收方点开是 404，反而误导用户。
 * 消息只保留「是什么任务、什么时候、哪个项目」这些确实可用的信息。
 *
 * @param projectNames 项目 id → 名称的映射，来自 Cloud API 项目缓存
 */
export function renderMessage(
  plan: PlannedNotification,
  projectNames: ReadonlyMap<string, string>,
): NotifyMessage {
  const message: NotifyMessage = {
    event: plan.event,
    sentAt: new Date().toISOString(),
  };

  // 单任务提醒：允许带描述（与官方一致）。
  if (plan.task) {
    const task = plan.task;
    message.task = {
      id: task.id,
      title: typeof task.title === 'string' ? task.title : '(无标题)',
      status: task.status,
      ...(task.dueDate ? { dueDate: String(task.dueDate) } : {}),
      ...(task.startTime ? { startTime: String(task.startTime) } : {}),
      ...(task.reviewAt ? { reviewAt: String(task.reviewAt) } : {}),
      ...(task.projectId ? { projectId: String(task.projectId) } : {}),
      ...(task.projectId && projectNames.has(String(task.projectId))
        ? { projectName: projectNames.get(String(task.projectId)) }
        : {}),
      ...(typeof task.description === 'string' ? { description: stripMarkdown(task.description) } : {}),
    };
  }

  // 汇总类：只有摘要/清单，明确不带 description。
  if (plan.digest) message.digest = plan.digest;
  if (plan.backlog) message.backlog = plan.backlog;

  // 项目回顾（BASE-07）：只带项目 id 与标题，项目其它字段一律不外发。
  if (plan.project) message.project = plan.project;

  // 触发点信息统一挂载：任务级与项目回顾都有，汇总类没有。
  if (plan.trigger) message.trigger = plan.trigger;

  return message;
}

/**
 * 提醒抬头：明确告诉接收方「什么来源的提醒 + 针对哪种时间」。
 *
 * 两段标签，用中点连接，例如：
 *   - `任务提醒 · 截止时间`（event = task.due / task.due_advance / task.due_repeat）
 *   - `任务提醒 · 开始时间`（task.start / task.start_advance）
 *   - `任务提醒 · 回顾时间`（task.review）
 *   - `项目提醒 · 回顾时间`（task.project_review）
 *   - `其他提醒 · 晨间简报`（摘要 / 积压 / 系统 / 测试等，无单一时刻）
 *
 * 为什么按 event 而不是按消息里「存在哪些时间字段」判断：一条任务可能同时带
 * dueDate 与 startTime，若按字段猜会同时打出两种时间、看不出到底哪个触发了提醒。
 * 触发点本身（plan.kind → event）才是唯一可信来源。
 *
 * @param event PlannedNotification.event 或 NotifyMessage.event
 * @returns 形如「任务提醒 · 截止时间」的抬头文本（不含书名号，调用方自行加）
 */
export function reminderHeading(event: string): string {
  // 项目回顾虽以 task. 开头，但来源是项目，单独判定。
  if (event === 'task.project_review') return '项目提醒 · 回顾时间';

  // 任务级：事件名形如 task.due / task.start_advance，取中间的时间类型词。
  if (event.startsWith('task.')) {
    const source = '任务提醒';
    if (event.includes('due')) return `${source} · 截止时间`;
    if (event.includes('start')) return `${source} · 开始时间`;
    if (event.includes('review')) return `${source} · 回顾时间`;
    return source;
  }

  // 其余（摘要 / 积压 / 系统 / 测试 / 仅日期）：无单一触发时刻，归为其他提醒，
  // 并保留原有事件短标签，让人知道具体是哪一种。
  const detail: Record<string, string> = {
    digest_morning: '晨间简报',
    digest_evening: '晚间回顾',
    digest_weekly: '每周回顾',
    date_only: '今日到期',
    backlog: '积压逾期',
    system: '系统通知',
    test: '渠道测试',
  };
  const tail = detail[event] ?? event;
  return `${'其他提醒'}${tail ? ` · ${tail}` : ''}`;
}

/** 事件类型 → 中文标题，用于邮件主题。 */
function subjectFor(plan: PlannedNotification, message: NotifyMessage): string {
  // 抬头统一带来源与时间类别，摘要类再补上各自的统计信息。
  const heading = reminderHeading(plan.event);
  if (plan.kind === 'backlog') return `[Notify] ${heading}（${plan.backlog?.count ?? 0} 条）`;
  if (plan.kind === 'digest-morning') return `[Notify] ${heading}（今日到期 ${message.digest?.dueToday.length ?? 0} / 逾期 ${message.digest?.overdue.length ?? 0}）`;
  if (plan.kind === 'digest-evening') return `[Notify] ${heading}`;
  if (plan.kind === 'digest-weekly') return `[Notify] ${heading}`;
  if (plan.kind === 'date-only') return `[Notify] ${heading}（${message.digest?.dueToday.length ?? 0} 条，仅日期任务）`;

  const subjectName = message.task?.title ?? message.project?.title ?? '';
  return `[Notify] ${heading}：${subjectName}`;
}

/** 把任务摘要列表渲染成纯文本行，汇总类通知共用。 */
function linesForTasks(
  tasks: TaskSummary[] | undefined,
  indent = '- ',
  time?: TimeFormatOptions,
): string {
  if (!tasks?.length) return '（无）';
  return tasks
    .map(task => {
      // 摘要里的 dueDate 可能只是日期，formatStamp 会原样保留，不会补出 00:00:00。
      const due = task.dueDate ? `（截止 ${time ? formatStamp(task.dueDate, time) : task.dueDate}）` : '';
      return `${indent}${task.title}${due}`;
    })
    .join('\n');
}

/**
 * 渲染邮件内容。HTML 版本做最基本的转义，避免任务标题里带尖括号破坏结构。
 */
export function renderEmail(
  plan: PlannedNotification,
  message: NotifyMessage,
  config: NotifyConfig,
): EmailContent {
  const subject = subjectFor(plan, message);
  const time: TimeFormatOptions = { pattern: config.timeFormat, timeZone: config.timezone };
  const parts: string[] = [`【${reminderHeading(plan.event)}】`];

  if (message.task) {
    parts.push(`任务：${message.task.title}`);
    parts.push(`状态：${message.task.status}`);
    // 只展示本次触发对应的那一种时间，避免任务同时有 dueDate/startTime 时分不清哪个在提醒。
    if (plan.kind.startsWith('due') && message.task.dueDate) {
      parts.push(`截止时间：${formatStamp(message.task.dueDate, time)}`);
    } else if (plan.kind.startsWith('start') && message.task.startTime) {
      parts.push(`开始时间：${formatStamp(message.task.startTime, time)}`);
    } else if (plan.kind === 'review' && message.task.reviewAt) {
      parts.push(`回顾时间：${formatStamp(message.task.reviewAt, time)}`);
    }
    if (message.task.projectName) parts.push(`项目：${message.task.projectName}`);
    if (message.task.description) parts.push(`\n描述：${message.task.description}`);
  }
  if (message.project) {
    parts.push(`项目：${message.project.title ?? message.project.id}`);
    if (message.trigger?.at) parts.push(`回顾时间：${formatStamp(message.trigger.at, time)}`);
  }
  if (message.digest) {
    parts.push(`今日到期：\n${linesForTasks(message.digest.dueToday, '- ', time)}`);
    parts.push(`\n已逾期：\n${linesForTasks(message.digest.overdue, '- ', time)}`);
    parts.push(`\n今日开始：\n${linesForTasks(message.digest.startingToday, '- ', time)}`);
    parts.push(`\n专注任务：\n${linesForTasks(message.digest.focused, '- ', time)}`);
  }
  if (message.backlog) {
    parts.push(`共 ${message.backlog.count} 条逾期未完成任务：\n${linesForTasks(message.backlog.tasks, '- ', time)}`);
  }

  const text = parts.join('\n');
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return {
    to: config.channels.email.to,
    subject,
    text,
    html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.7">${escaped}</div>`,
  };
}
