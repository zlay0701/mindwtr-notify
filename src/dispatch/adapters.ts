/**
 * 平台适配器（M3 · EXT-19【官方无】）
 *
 * 把同一条 NotifyMessage 转成钉钉 / 企业微信 / 飞书各自要求的格式与签名：
 *
 *   钉钉   sign 放在 URL 查询参数，算法 HMAC-SHA256(key=secret, data=`${timestamp}\n${secret}`)
 *   飞书   sign 放在 JSON body，算法 HMAC-SHA256(key=`${timestamp}\n${secret}`, data='')
 *   企业微信 无签名（密钥在 URL 的 key 参数里），只需 text 格式
 *
 * 两家的签名字符串看着像，密钥与数据的位置正好相反，是最容易写错的地方，
 * 因此单独拆成两个函数并各写一条测试固定住。
 */

import { createHmac } from 'node:crypto';
import type { WebhookAdapter } from '../config.ts';
import { formatStamp, type TimeFormatOptions } from '../format.ts';
import { DEFAULT_TIME_FORMAT } from '../rules/time.ts';
import type { NotifyMessage } from './message.ts';
import { postWebhook, type DeliveryResult, type WebhookPostOptions } from './webhook.ts';

export interface PlatformRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 钉钉加签：timestamp 用毫秒，sign 为 base64，最终追加到 URL。 */
export function dingtalkSign(secret: string, timestampMs: number): string {
  return createHmac('sha256', secret)
    .update(`${timestampMs}\n${secret}`)
    .digest('base64');
}

/** 飞书加签：timestamp 用秒，以「时间戳+换行+密钥」作为 HMAC 的密钥，数据为空串。 */
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`)
    .update('')
    .digest('base64');
}

/** 事件类型 → 中文短标签，机器人消息里一眼能看出是什么提醒。 */
function eventLabel(event: string): string {
  const labels: Record<string, string> = {
    'task.due': '截止提醒',
    'task.due_advance': '即将截止',
    'task.due_repeat': '截止催办',
    'task.start': '开始提醒',
    'task.start_advance': '即将开始',
    'task.review': '回顾提醒',
    'task.project_review': '项目回顾',
    digest_morning: '晨间简报',
    digest_evening: '晚间回顾',
    digest_weekly: '每周回顾',
    date_only: '今日到期',
    backlog: '积压逾期',
    system: '系统通知',
    test: '渠道测试',
  };
  return labels[event] ?? event;
}

/**
 * 把结构化消息渲染成机器人可读的纯文本，内容同样遵守 EXT-03 数据最小化。
 * @param time 显示格式与时区（EXT-21）；不传时用默认格式 + Asia/Shanghai，便于单测直接调用
 */
export function renderPlatformText(
  message: NotifyMessage,
  time: TimeFormatOptions = { pattern: DEFAULT_TIME_FORMAT, timeZone: 'Asia/Shanghai' },
): string {
  const lines: string[] = [`【${eventLabel(message.event)}】`];

  if (message.task) {
    lines.push(`任务：${message.task.title}`);
    if (message.task.dueDate) lines.push(`截止：${formatStamp(message.task.dueDate, time)}`);
    if (message.task.startTime) lines.push(`开始：${formatStamp(message.task.startTime, time)}`);
    if (message.task.projectName) lines.push(`项目：${message.task.projectName}`);
    if (message.task.description) lines.push(`描述：${message.task.description}`);
  }
  if (message.project) {
    lines.push(`项目：${message.project.title ?? message.project.id}`);
    if (message.trigger?.at) lines.push(`回顾时间：${formatStamp(message.trigger.at, time)}`);
  }
  if (message.digest) {
    const digest = message.digest;
    lines.push(`今日到期 ${digest.dueToday.length} 条 / 逾期 ${digest.overdue.length} 条`);
    for (const task of [...digest.dueToday, ...digest.overdue].slice(0, 5)) {
      lines.push(`- ${task.title}`);
    }
  }
  if (message.backlog) {
    lines.push(`积压逾期 ${message.backlog.count} 条`);
    for (const task of message.backlog.tasks.slice(0, 5)) lines.push(`- ${task.title}`);
  }
  if (message.note) lines.push(message.note);
  // 不追加「打开链接」：Cloud 没有可直接打开的 Web 任务页（v1.22）。
  return lines.join('\n');
}

/**
 * 生成目标平台需要的最终请求（URL、请求头、消息体）。
 * @param now 可注入的当前时间，便于单测固定签名的输入
 */
export function buildPlatformRequest(
  kind: WebhookAdapter,
  url: string,
  secret: string,
  message: NotifyMessage,
  now = Date.now(),
  time?: TimeFormatOptions,
): PlatformRequest {
  const text = renderPlatformText(message, time);
  const headers = { 'Content-Type': 'application/json' };

  if (kind === 'dingtalk') {
    const target = new URL(url);
    if (secret) {
      target.searchParams.set('timestamp', String(now));
      target.searchParams.set('sign', dingtalkSign(secret, now));
    }
    return {
      url: target.toString(),
      headers,
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: 'Notify 提醒', text },
      }),
    };
  }

  if (kind === 'wecom') {
    return {
      url,
      headers,
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    };
  }

  if (kind === 'feishu') {
    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: { text },
    };
    if (secret) {
      const timestamp = Math.floor(now / 1000);
      payload.timestamp = String(timestamp);
      payload.sign = feishuSign(secret, timestamp);
    }
    return { url, headers, body: JSON.stringify(payload) };
  }

  // generic 兜底：保持原始结构化消息（正常路径由 deliverWebhook 处理）。
  return { url, headers, body: JSON.stringify(message) };
}

/** 构造平台请求并投递，复用通用通道的 POST 重试逻辑。 */
export async function deliverPlatformWebhook(
  kind: WebhookAdapter,
  url: string,
  secret: string,
  message: NotifyMessage,
  options: WebhookPostOptions & { now?: number; time?: TimeFormatOptions } = {},
): Promise<DeliveryResult> {
  const request = buildPlatformRequest(
    kind, url, secret, message, options.now ?? Date.now(), options.time,
  );
  return postWebhook(request.url, request.body, request.headers, options);
}
