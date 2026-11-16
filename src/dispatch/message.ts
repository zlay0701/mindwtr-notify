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
    message.trigger = plan.trigger;
  }

  // 汇总类：只有摘要/清单，明确不带 description。
  if (plan.digest) message.digest = plan.digest;
  if (plan.backlog) message.backlog = plan.backlog;

  return message;
}

/** 事件类型 → 中文标题，用于邮件主题。 */
function subjectFor(plan: PlannedNotification, message: NotifyMessage): string {
  if (plan.kind === 'backlog') return `[Notify] 积压逾期清单（${plan.backlog?.count ?? 0} 条）`;
  if (plan.kind === 'digest-morning') return `[Notify] 晨间简报（今日到期 ${message.digest?.dueToday.length ?? 0} / 逾期 ${message.digest?.overdue.length ?? 0}）`;
  if (plan.kind === 'digest-evening') return '[Notify] 晚间回顾';
  if (plan.kind === 'digest-weekly') return '[Notify] 每周回顾';
  if (plan.kind === 'date-only') return `[Notify] 今日到期（${message.digest?.dueToday.length ?? 0} 条，仅日期任务）`;

  const labels: Record<string, string> = {
    start: '开始提醒', 'start-advance': '即将开始',
    due: '截止提醒', 'due-advance': '即将截止', 'due-repeat': '截止催办',
    review: '回顾提醒', 'project-review': '项目回顾',
  };
  return `[Notify] ${labels[plan.kind] ?? '提醒'}：${message.task?.title ?? ''}`;
}

/** 把任务摘要列表渲染成纯文本行，汇总类通知共用。 */
function linesForTasks(tasks: TaskSummary[] | undefined, indent = '- '): string {
  if (!tasks?.length) return '（无）';
  return tasks.map(task => `${indent}${task.title}${task.dueDate ? `（截止 ${task.dueDate}）` : ''}`).join('\n');
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
  const parts: string[] = [];

  if (message.task) {
    parts.push(`任务：${message.task.title}`);
    parts.push(`状态：${message.task.status}`);
    if (message.task.dueDate) parts.push(`截止：${message.task.dueDate}`);
    if (message.task.startTime) parts.push(`开始：${message.task.startTime}`);
    if (message.task.projectName) parts.push(`项目：${message.task.projectName}`);
    if (message.task.description) parts.push(`\n描述：${message.task.description}`);
  }
  if (message.digest) {
    parts.push(`今日到期：\n${linesForTasks(message.digest.dueToday)}`);
    parts.push(`\n已逾期：\n${linesForTasks(message.digest.overdue)}`);
    parts.push(`\n今日开始：\n${linesForTasks(message.digest.startingToday)}`);
    parts.push(`\n专注任务：\n${linesForTasks(message.digest.focused)}`);
  }
  if (message.backlog) {
    parts.push(`共 ${message.backlog.count} 条逾期未完成任务：\n${linesForTasks(message.backlog.tasks)}`);
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
