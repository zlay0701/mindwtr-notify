/**
 * 显示用时间格式化（EXT-21【官方无】）
 *
 * 只用于**人看的文本**：邮件正文、钉钉 / 企微 / 飞书消息。
 * 结构化 JSON（`generic` 通道）必须保持 ISO 8601 —— 接收端要能机器解析，
 * 不能跟着显示格式配置一起变。
 */

import { hasTimeComponent } from './rules/reminder-plan.ts';
import { formatDateTime } from './rules/time.ts';

/** 渲染一句人看的文本需要的信息：格式与业务时区。 */
export interface TimeFormatOptions {
  pattern: string;
  timeZone: string;
}

/**
 * 把一个时间字段渲染成人类可读文本。
 *
 * 三种情况刻意保持原样，避免「格式化」反而丢信息：
 *   1. 仅日期（`2026-11-16`）：本来就没有时刻，补 `00:00:00` 会误导（与 BASE-22 同一套判定）；
 *   2. 解析不了的字符串：原样输出，方便发现数据问题，而不是显示空白；
 *   3. 空值 / 非字符串：返回空串，由调用方决定是否跳过该行。
 *
 * @param value   任务字段或 ISO 时间戳（`dueDate` / `startTime` / `trigger.at` 等）
 * @param options 格式与业务时区
 * @returns 人类可读文本；无法处理时返回原值
 */
export function formatStamp(value: unknown, options: TimeFormatOptions): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (!hasTimeComponent(value)) return value;

  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return value;

  return formatDateTime(epoch, options.timeZone, options.pattern);
}
