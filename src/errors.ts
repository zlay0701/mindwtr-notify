/**
 * 错误信息归一化（跨模块公用）
 *
 * 把任意异常或错误文本转成一句可以安全写进状态库与日志的短文本。
 *
 * 为什么统一在这里处理：
 *   1. Bun 下 socket 类错误的 Error.message 可能是空串，`??` 只兜 null / undefined，
 *      直接落库会让 sent_log.last_error 变成空白，排查时看不出失败原因；
 *   2. fetch / SMTP 异常文本常带完整 URL，而 Webhook URL 可能含密钥，
 *      按本项目约束绝不能把 URL 写进数据库或日志（见 src/dispatch/index.ts 文件头）；
 *   3. 异常文本可能很长，截断到 160 字避免撑爆管理页与日志。
 */

/**
 * 把文本里的 http(s) URL 整段替换成 `[url]`。
 * Webhook URL 常带密钥，Cloud 异常文本也可能带完整地址；日志与状态库共用这一处脱敏，
 * 避免规则分散后某条新日志漏掉。
 * @param text 任意文本
 * @returns 不含 http(s) URL 的文本
 */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '[url]');
}

/**
 * 把异常或错误文本转成非空、脱敏、定长的一句话。
 * @param error    任意异常、字符串，或 undefined / 空串
 * @param fallback 取不到有效文本时使用的兜底文案
 * @returns 一定非空、不含 http(s) URL、最多 160 字的字符串
 */
export function describeError(error: unknown, fallback = '未知错误'): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const cleaned = redactUrls(raw).slice(0, 160).trim();
  // 用 || 而不是 ??：空串也是「没有有效信息」，必须落到兜底文案。
  return cleaned || fallback;
}
