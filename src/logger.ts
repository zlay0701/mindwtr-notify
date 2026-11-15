/**
 * 分级日志（v1.13 · EXT-20【官方无】）
 *
 * 职责：把运行时的诊断日志按级别过滤，统一输出成
 *   `2026-11-15 20:24:03 [INFO ] [notify] 消息 key=value`
 * 便于日常只看摘要、排障时开 debug 看完整链路。
 *
 * 两条必须守住的边界：
 *   1. 命令输出不走这里。`--dry-run` / `--once` / `--test-*` / `--help` 的结果是
 *      「命令给人看的输出」，不是日志；如果也按级别过滤，把级别调成 error 后
 *      命令就成了哑巴。这类输出仍由 cli.ts 直接 console 打印。
 *   2. 所有日志文本统一脱敏。debug 会打印 Cloud 请求、渠道与失败原因，
 *      而 Webhook URL 常带密钥、异常文本也可能带完整 URL，
 *      所以 message 与 fields 都要过 redactUrls（见 errors.ts 文件头）。
 *
 * 零运行时依赖：只用 Node 内置的 Intl 与 console，Bun / Node 22 均可直接运行。
 */

import { redactUrls } from './errors.ts';

/** 五个级别：前四个是真实日志级别，silent 表示一条都不输出。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** 可选值清单，同时用于配置解析、CLI 报错提示与文档。 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

/** 用于 emit 的级别（silent 不能作为一条日志的级别）。 */
export type EmitLevel = Exclude<LogLevel, 'silent'>;

/** 级别数值：越大越严重，输出时只保留「数值 >= 当前配置」的日志。 */
const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 100,
};

/** 结构化字段的值类型；null / undefined 会被跳过。 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 该级别当前是否会被输出；构造昂贵诊断信息前可先判断，避免白算。 */
  enabled(level: EmitLevel): boolean;
}

export interface LoggerOptions {
  /** 当前生效的级别。 */
  level: LogLevel;
  /** 日志时间使用的时区；不传则用运行环境本地时区。传业务时区可与提醒时刻对齐。 */
  timezone?: string;
  /** 输出目标；测试里注入收集函数。默认 info/debug 走 stdout，warn/error 走 stderr。 */
  sink?: (line: string, level: EmitLevel) => void;
  /** 可注入时钟，测试里固定时间。 */
  now?: () => Date;
}

/**
 * 解析配置里的级别字符串：大小写与首尾空格都容错。
 * @param value 来自环境变量、JSON 配置或命令行的原始值
 * @returns 识别成功返回对应级别；空值或无法识别返回 null（由调用方决定回退还是报错）
 */
export function parseLogLevel(value: string | undefined | null): LogLevel | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return LOG_LEVELS.includes(normalized as LogLevel) ? normalized as LogLevel : null;
}

/**
 * 把时间格式化成 `YYYY-MM-DD HH:mm:ss`。
 * 用 formatToParts 而不是 toLocaleString：后者在不同 ICU 版本里分隔符可能是
 * 窄空格，会让日志难以被 grep；逐字段拼接的结果稳定可控。
 * 时区写错时 Intl 会抛错，此时回退到运行环境本地时区，不让日志把服务搞挂。
 */
function formatTime(date: Date, timezone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', timezone ? { ...options, timeZone: timezone } : options)
      .formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** 把结构化字段拼成 ` key=value`；含空格的值加引号，保证肉眼和 grep 都能解析。 */
function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const text = redactUrls(String(value));
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** 默认输出：警告与错误走 stderr，便于 `docker logs` 之外的分流工具单独采集。 */
function defaultSink(line: string, level: EmitLevel): void {
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}

/**
 * 创建日志器。
 * @param options.level    当前级别；低于它的日志直接丢弃（连字符串都不拼装）
 * @param options.timezone 时间戳时区，一般传 config.timezone
 * @param options.sink     自定义输出，主要用于单元测试
 * @param options.now      自定义时钟，主要用于单元测试
 * @returns 带 debug/info/warn/error/enabled 的日志器
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level;
  const minimum = LEVEL_VALUE[level];
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? defaultSink;

  function write(at: EmitLevel, message: string, fields?: LogFields): void {
    if (LEVEL_VALUE[at] < minimum) return;
    const tag = at.toUpperCase().padEnd(5);
    const line = `${formatTime(now(), options.timezone)} [${tag}] [notify] ${redactUrls(message)}${formatFields(fields)}`;
    sink(line, at);
  }

  return {
    level,
    enabled: (at) => LEVEL_VALUE[at] >= minimum,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
