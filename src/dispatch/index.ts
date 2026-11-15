/**
 * 统一分发器
 *
 * 把一条消息投递到所有启用的渠道，并给每个渠道返回独立结果——
 * 邮件成功不能让失败的 Webhook 失去重试机会（EXT-07【增强】渠道级去重）。
 *
 * 渠道命名刻意用 `email` / `webhook:0` 这种稳定短名：
 * Webhook URL 常带密钥，绝不能作为去重键或日志内容写进数据库。
 */

import { describeError } from '../errors.ts';
import type { NotifyConfig } from '../config.ts';
import type { StateStore } from '../state/store.ts';
import { createSmtpTransport, type MailTransport } from './email.ts';
import type { EmailContent, NotifyMessage } from './message.ts';
import { deliverPlatformWebhook } from './adapters.ts';
import { deliverWebhook, type DeliveryResult } from './webhook.ts';

export interface Dispatcher {
  /** 已启用的渠道名，顺序稳定。 */
  channels: string[];
  /** 只投递指定渠道，供 Scheduler 做渠道级去重与独立重试。 */
  deliverChannel(channel: string, payload: { message: NotifyMessage; email: EmailContent }): Promise<DeliveryResult>;
  deliver(payload: { message: NotifyMessage; email: EmailContent }): Promise<Record<string, DeliveryResult>>;
}

export interface DispatcherOptions {
  /** 可注入的邮件通道，测试时用文件 transport 替代真实 SMTP。 */
  mailTransport?: MailTransport | null;
  /** 可注入的 fetch，测试 Webhook 时不打真实网络。 */
  fetchImpl?: typeof fetch;
  /** 可注入的等待函数，避免重试测试真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 创建分发器。未启用的渠道不出现在 channels 里。 */
export function createDispatcher(config: NotifyConfig, options: DispatcherOptions = {}): Dispatcher {
  const mailTransport = options.mailTransport === undefined
    ? createSmtpTransport(config)
    : options.mailTransport;

  const channels: string[] = [];
  if (config.channels.email.enabled && mailTransport) channels.push('email');
  if (config.channels.webhook.enabled) {
    config.channels.webhook.urls.forEach((_, index) => channels.push(`webhook:${index}`));
  }

  /** 单渠道投递。签名与发送共用同一份 rawBody，满足 EXT-04 的验签要求。 */
  const deliverChannel = async (
    channel: string,
    { message, email }: { message: NotifyMessage; email: EmailContent },
  ): Promise<DeliveryResult> => {
    const rawBody = JSON.stringify(message);

    if (channel === 'email') {
      if (!mailTransport) return { ok: false, attempts: 0, error: '邮件通道未配置' };
      try {
        await mailTransport.send(email);
        return { ok: true, attempts: 1 };
      } catch (error) {
        return {
          ok: false,
          attempts: 1,
          // Bun 下 socket 错误的 message 可能是空串；同时去掉异常文本里可能含密钥的 URL。
          error: describeError(error, 'SMTP 发送失败（未提供错误详情）'),
        };
      }
    }

    if (channel.startsWith('webhook:')) {
      const index = Number(channel.slice('webhook:'.length));
      const url = config.channels.webhook.urls[index];
      if (!url) return { ok: false, attempts: 0, error: 'Webhook URL 不存在' };

      // M3：按 URL 对应的平台类型改写消息格式与签名；缺省仍是通用 HMAC 通道。
      const kind = config.m3.adapters.kinds[index] ?? 'generic';
      if (kind !== 'generic') {
        const secret = config.m3.adapters.secrets[index] || config.channels.webhook.secret;
        return deliverPlatformWebhook(kind, url, secret, message, {
          fetchImpl: options.fetchImpl,
          maxAttempts: config.channels.webhook.maxAttempts,
          sleep: options.sleep,
        });
      }

      return deliverWebhook(url, rawBody, config.channels.webhook.secret, {
        fetchImpl: options.fetchImpl,
        maxAttempts: config.channels.webhook.maxAttempts,
        sleep: options.sleep,
      });
    }

    return { ok: false, attempts: 0, error: '未知渠道' };
  };

  return {
    channels,
    deliverChannel,
    async deliver(payload) {
      const results: Record<string, DeliveryResult> = {};
      for (const channel of channels) {
        results[channel] = await deliverChannel(channel, payload);
      }
      return results;
    },
  };
}

/**
 * 构造渠道级去重键（BASE-29 逻辑 + EXT-07 channel 维度）。
 * 例：`task-1:due:2026-11-13T09:00:00.000Z:email`
 */
export function channelDedupeKey(planKey: string, channel: string): string {
  return `${planKey}:${channel}`;
}

/** 记录投递结果到状态库：每渠道独立，失败保留重试机会。 */
export function recordDelivery(
  store: StateStore,
  key: string,
  result: DeliveryResult,
  meta: { taskId: string; triggerType: string; triggerAt: number; channel: string },
): void {
  store.markPending(key, meta);
  if (result.ok) store.markSent(key);
  // 用 || 而不是 ??：空串也要落到兜底文案；describeError 还会脱敏并截断，
  // 避免异常文本里的 Webhook URL（可能含密钥）被原样写进状态库。
  else store.markFailed(key, describeError(result.error, '未知错误'));
}
