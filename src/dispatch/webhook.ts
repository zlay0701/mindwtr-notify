/**
 * Webhook 投递（EXT-04【官方无】签名、EXT-05【官方无】多 URL 与重试）
 *
 * 通用通道的签名规范（spec §7 第 5 条）：
 *   X-Notify-Timestamp : Unix 秒
 *   X-Notify-Signature : sha256=<hex>
 *   签名串 = `${timestamp}.${rawBody}`，rawBody 必须是发送时的原始 JSON 字节，
 *   接收方不能重新序列化后再验签，否则空格/字段顺序变化就会验不过。
 *
 * M3 起把「POST + 重试」抽成 postWebhook：钉钉/企微/飞书适配器各自生成
 * URL、请求头与消息体后复用同一套重试逻辑，通用通道行为保持不变。
 *
 * v1.15 补业务响应校验：企业微信 / 钉钉 / 飞书可能在 HTTP 200 里返回
 * `{"errcode":40058,...}`，只按 response.ok 判定会「日志显示成功但群里没消息」。
 * 现在对 2xx 响应再读一次业务码，但只对**明确属于机器人平台**的响应形状生效：
 * 空 body、非 JSON、自定义接收端返回的普通 JSON 仍按原来的 HTTP 语义处理。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { describeError, redactUrls } from '../errors.ts';

/** 生成通用通道的签名值。 */
export function signBody(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * 接收方验签（同时提供给对接方参考）。
 * 时间戳偏差超过 toleranceSec 直接拒绝，防止重放；比较用恒定时间函数。
 */
export function verifySignature(
  secret: string,
  timestamp: number,
  rawBody: string,
  signature: string,
  toleranceSec = 300,
): boolean {
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSec) return false;

  const expected = signBody(secret, timestamp, rawBody);
  const provided = signature.replace(/^sha256=/, '');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(provided, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

export interface WebhookPostOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  /** 可注入的等待函数，单元测试里换成空实现以免真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 业务码失败的描述，用于错误信息与状态库 last_error。 */
export interface WebhookBusinessError {
  code: number;
  message: string;
}

// 只读响应体的前 4KB：机器人响应很短，限制长度可避免异常接收端返回超大 body。
const MAX_RESPONSE_CHARS = 4096;
// 业务错误描述最多保留 120 字，防止 errmsg 撑爆日志与状态库。
const MAX_BUSINESS_MESSAGE = 120;

/** 业务描述只取字符串、脱敏并截断，绝不把整个响应体写进错误。 */
function shortBusinessMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return redactUrls(value).slice(0, MAX_BUSINESS_MESSAGE).trim();
}

/** 把业务码格式化成一句可读、脱敏、定长的错误文本。 */
function formatBusinessError(error: WebhookBusinessError): string {
  const detail = error.message ? ` ${error.message}` : '';
  return describeError(`errcode=${error.code}${detail}`, '业务码非 0');
}

/**
 * 从响应体里识别「HTTP 200 但业务失败」。
 *
 * 为什么只认三种明确的字段形状：generic 是用户自建接收端，可能返回
 * `{"code":200}` 这类自有格式，若无条件把非零 code 当失败会误伤。因此
 *   - `errcode`（企业微信 / 钉钉）语义足够明确，是数字就认；
 *   - 飞书的 `StatusCode` / `code` 必须**同时带消息字段**才认，缩小误判面。
 * 返回 null 表示「这不是业务码响应」，调用方继续按 HTTP 状态判定。
 *
 * @param text 响应体文本，允许为空或非 JSON
 * @returns 业务错误；null 表示没有可识别的业务错误
 */
export function parseWebhookBusinessError(text: string): WebhookBusinessError | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null; // 纯文本、HTML 或截断的 JSON 都不是业务码响应
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const data = json as Record<string, unknown>;

  // 企业微信 / 钉钉：成功固定 errcode=0，非 0 即业务失败。
  if (typeof data.errcode === 'number' && Number.isFinite(data.errcode)) {
    if (data.errcode === 0) return null;
    return {
      code: data.errcode,
      message: shortBusinessMessage(data.errmsg) || shortBusinessMessage(data.msg),
    };
  }

  // 飞书：新版 StatusCode + StatusMessage，旧版 code + msg；必须有消息字段才认。
  const hasMessageField = typeof data.StatusMessage === 'string' || typeof data.msg === 'string';
  if (!hasMessageField) return null;
  const code = typeof data.StatusCode === 'number' ? data.StatusCode
    : typeof data.code === 'number' ? data.code : null;
  if (code === null || !Number.isFinite(code) || code === 0) return null;

  return {
    code,
    message: shortBusinessMessage(data.StatusMessage) || shortBusinessMessage(data.msg),
  };
}

/**
 * 读取响应体并解析业务码。
 * 读不出来（网络中断、某些 mock 不实现 text）时返回 null，
 * 不把一次已经成功的 HTTP 请求倒扣成失败。
 */
async function readBusinessError(response: Response): Promise<WebhookBusinessError | null> {
  try {
    const text = await response.text();
    return parseWebhookBusinessError(text.slice(0, MAX_RESPONSE_CHARS));
  } catch {
    return null;
  }
}

/**
 * 底层 POST + 指数退避重试。
 *
 * 抽出来的原因：三个平台适配器的 URL、签名头、消息体各不相同，
 * 但「失败重试几次、间隔多久、怎么判定成功」应该完全一致。
 * v1.15 起在 HTTP 判定之后再加一层业务码判定，覆盖机器人平台
 * 「200 + errcode!=0」这种假成功。
 */
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: WebhookPostOptions = {},
): Promise<DeliveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const business = await readBusinessError(response);

      if (response.ok && !business) return { ok: true, attempts: attempt };

      // HTTP 200 + 业务码非 0：平台收下了请求但拒绝投递（无效 key、消息格式不合法等）。
      // 这类错误是确定性的，重发同一个 body 只会刷群，因此立即返回失败、不做即时重试；
      // 状态库记为 failed，由下一轮调度（默认 60s）跨轮重投兜底，消息不会丢。
      if (response.ok && business) {
        return {
          ok: false,
          attempts: attempt,
          error: `Webhook 业务失败：${formatBusinessError(business)}`,
        };
      }

      // 非 2xx 仍按原逻辑重试；响应体里若带业务码，并进错误文本方便排查。
      lastError = business
        ? `HTTP ${response.status} / ${formatBusinessError(business)}`
        : `HTTP ${response.status}`;
    } catch (error) {
      // 统一做空串兜底与 URL 脱敏：异常文本常带完整 Webhook URL，其中可能含密钥。
      lastError = describeError(error, 'Webhook 请求异常（未提供错误详情）');
    }
    // 指数退避：失败后 200ms / 400ms / 800ms… 再试，避免把接收方打爆。
    if (attempt < maxAttempts) await sleep(200 * (2 ** (attempt - 1)));
  }
  // lastError 理论上必被赋值，这里仍用 || 兜底，保证 result.error 永远是可读文本。
  return { ok: false, attempts: maxAttempts, error: lastError || 'Webhook 投递失败（未提供错误详情）' };
}

/**
 * 通用 Webhook 通道：加 HMAC 签名头后交给 postWebhook。
 * 签名与发送共用同一份 rawBody，满足 EXT-04 的验签要求。
 */
export async function deliverWebhook(
  url: string,
  rawBody: string,
  secret: string,
  options: WebhookPostOptions = {},
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signBody(secret, timestamp, rawBody);
  return postWebhook(url, rawBody, {
    'Content-Type': 'application/json',
    'X-Notify-Timestamp': String(timestamp),
    'X-Notify-Signature': `sha256=${signature}`,
  }, options);
}
