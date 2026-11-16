/**
 * 时区工具
 *
 * 为什么不直接用 new Date().getHours()：VPS 的系统时区可能是 UTC，
 * 而摘要、静默时段、仅日期任务提醒都必须按用户配置的时区（默认 Asia/Shanghai）判定。
 * 这里用 Node 内置 Intl 做换算，保持零依赖。
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=周日，和官方 weekly-review 的 day 语义一致。 */
  weekday: number;
  /** YYYY-MM-DD，摘要去重键用它（BASE-29）。 */
  dateKey: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 把 UTC 时间戳换算成指定时区的日历字段。 */
export function getZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayLabel = parts.find(part => part.type === 'weekday')?.value ?? 'Sun';

  const year = value('year');
  const month = value('month');
  const day = value('day');
  return {
    year,
    month,
    day,
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
    weekday: Math.max(0, weekdayNames.indexOf(weekdayLabel)),
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** 消息里显示时间的默认格式（EXT-21【官方无】），可按 NOTIFY_TIME_FORMAT 覆盖。 */
export const DEFAULT_TIME_FORMAT = 'yyyy-MM-dd HH:mm:ss';

/**
 * 把时间戳按指定时区渲染成人类可读文本。
 *
 * 支持的 token：`yyyy`（四位年）、`MM`（两位月）、`dd`（两位日）、
 * `HH`（24 小时制两位时）、`mm`（两位分）、`ss`（两位秒）。
 * 其它字符原样保留，所以 `yyyy/MM/dd HH:mm` 这类写法也能用。
 *
 * 为什么不用 toLocaleString：不同 Node / Bun / ICU 版本输出的分隔符与顺序不一样，
 * 日志与消息里会忽中忽西；这里自己拼，跨运行时完全一致。
 */
export function formatDateTime(epochMs: number, timeZone: string, pattern: string): string {
  const parts = getZonedParts(epochMs, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const tokens: Record<string, string> = {
    yyyy: String(parts.year),
    MM: pad(parts.month),
    dd: pad(parts.day),
    HH: pad(parts.hour),
    mm: pad(parts.minute),
    ss: pad(parts.second),
  };
  // 用一次性正则替换所有 token，避免「先把 MM 换成 08，再被后来的 m 规则破坏」这类顺序坑。
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, token => tokens[token] ?? token);
}

/** 解析 "HH:MM"，非法输入返回 00:00 并由调用方决定是否启用。 */
export function parseHm(text: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return { hour: 0, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** 某个时刻在指定时区相对 UTC 的偏移（毫秒）。 */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = getZonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * 把「某时区某天的 HH:MM」换算成 UTC 时间戳。
 *
 * 之所以算两次偏移：第一次用猜测值取到的偏移可能属于夏令时的另一侧，
 * 用修正后的时间再取一次偏移即可消除边界误差（BASE-23 的跨 DST 要求）。
 */
export function zonedTimeToEpoch(dateKey: string, hour: number, minute: number, timeZone: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = zoneOffsetMs(guess, timeZone);
  const secondOffset = zoneOffsetMs(guess - firstOffset, timeZone);
  return guess - secondOffset;
}

/** 一个时间戳在指定时区的日期键，用于判断「今日到期 / 已逾期」。 */
export function localDateKey(epochMs: number, timeZone: string): string {
  return getZonedParts(epochMs, timeZone).dateKey;
}

/** 解析任务里的时间字段；仅日期字符串按 UTC 午夜处理，再交给时区换算。 */
export function parseTaskDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
