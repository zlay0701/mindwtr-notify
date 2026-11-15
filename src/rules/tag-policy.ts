/**
 * 标签路由（M3 · EXT-19【官方无】）
 *
 * 用任务标签控制「这条提醒发到哪些渠道」：
 *   #silent / @silent       → 所有渠道都不投递
 *   #notify-email           → 只发邮件
 *   #notify-webhook         → 只发 Webhook（含钉钉/企微/飞书适配器）
 *
 * 重要边界：这里只过滤渠道，**不新增、不删除、不改时刻任何 BASE 触发点**。
 * 因此开启标签规则不会破坏 strict 计划比对结果（spec §13 验收标准）。
 * 能力开关默认关闭，只有 NOTIFY_TAG_RULES=true 才生效。
 */

import type { NotifyConfig } from '../config.ts';
import type { MindwtrTask } from '../types.ts';

/** 去掉前缀并转小写，让 `#silent`、`@silent`、`SILENT` 都能命中同一条规则。 */
function normalizeTag(value: string): string {
  return value.trim().replace(/^[#@]/, '').toLowerCase();
}

/**
 * 收集任务里的标签名。
 *
 * 数据来源有三处，因为客户端版本不同、标签存放方式不一致：
 *   1. 标题/描述正文里的 `#tag` / `@context`；
 *   2. `tags` 数组（可能是字符串，也可能是 {name,title} 对象）；
 *   3. `contexts` 数组（同上）。
 * 数组元素若是 tag id（UUID 形态）也会收进来，只是不会命中任何规则，无害。
 */
export function parseTaskTags(task: MindwtrTask): string[] {
  const tags = new Set<string>();

  for (const text of [task.title, task.description]) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(/[#@]([A-Za-z0-9_-]+)/g)) {
      tags.add(normalizeTag(match[1]));
    }
  }

  for (const field of ['tags', 'contexts']) {
    const value = task[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') {
        tags.add(normalizeTag(entry));
      } else if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = record.name ?? record.title ?? record.label;
        if (typeof name === 'string') tags.add(normalizeTag(name));
      }
    }
  }

  return [...tags];
}

export interface TagPolicy {
  /** 命中静默标签，整条提醒不投递。 */
  silent: boolean;
  /** 'all' 表示不限制；否则只包含 'email' 或 'webhook' 之一。 */
  allowed: 'all' | string[];
}

/** 解析单条任务的渠道策略。规则未启用时一律放行。 */
export function getTagPolicy(task: MindwtrTask, config: NotifyConfig): TagPolicy {
  const rules = config.m3.tagRules;
  if (!rules.enabled) return { silent: false, allowed: 'all' };

  const tags = parseTaskTags(task);
  const matches = (values: string[]) => values.some(value => tags.includes(normalizeTag(value)));

  if (matches(rules.silentTags)) return { silent: true, allowed: [] };
  if (matches(rules.emailTags)) return { silent: false, allowed: ['email'] };
  if (matches(rules.webhookTags)) return { silent: false, allowed: ['webhook'] };
  return { silent: false, allowed: 'all' };
}

/**
 * 按标签过滤渠道列表。
 * @param task 摘要类通知没有对应任务，传 undefined 时直接放行
 */
export function filterChannelsByTags(
  task: MindwtrTask | undefined,
  channels: string[],
  config: NotifyConfig,
): string[] {
  if (!task || !config.m3.tagRules.enabled) return channels;

  const policy = getTagPolicy(task, config);
  if (policy.allowed === 'all') return channels;
  if (policy.allowed.includes('email')) return channels.filter(channel => channel === 'email');
  if (policy.allowed.includes('webhook')) {
    return channels.filter(channel => channel.startsWith('webhook:'));
  }
  return []; // silent
}
