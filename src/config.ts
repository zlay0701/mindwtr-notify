/**
 * 配置加载与校验
 *
 * 优先级：函数传入的覆盖值 > 环境变量 > 本地 .env > 可选 JSON 配置文件 > 内置默认值。
 * 这样部署时只需改环境变量，不必改代码；本地开发放 .env 即可。
 *
 * 安全：token 只在这里被读取，任何日志、报告、healthz 输出都不会包含它。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactUrls } from './errors.ts';
import { LOG_LEVELS, parseLogLevel, type LogLevel } from './logger.ts';
import { normalizeNamespace, statePathForNamespace } from './state/namespace.ts';
import { DEFAULT_TIME_FORMAT } from './rules/time.ts';

/** 单条摘要规则。`at` 是本地时区的 HH:MM，weekly 额外用 day 表示星期（0=周日）。 */
export interface DigestRule {
  enabled: boolean;
  at: string;
  day?: number;
}

/** A 类扩展里「仅日期任务」的配置（EXT-16，默认关闭）。 */
export interface DateOnlyRule {
  enabled: boolean;
  at: string;
}

/** A 类扩展里「静默时段」的配置（EXT-18，默认关闭）。 */
export interface QuietHoursRule {
  enabled: boolean;
  start: string;
  end: string;
  defer: boolean;
}

/** Webhook 目标平台的消息格式类型（M3 · EXT-19【官方无】）。 */
export type WebhookAdapter = 'generic' | 'dingtalk' | 'wecom' | 'feishu';

export interface NotifyConfig {
  baseUrl: string;
  token: string;
  timezone: string;

  /**
   * EXT-21【官方无】：消息里显示时间的格式，默认 `yyyy-MM-dd HH:mm:ss`。
   * 只影响人看的文本（邮件正文、钉钉/企微/飞书文本），结构化 JSON 仍用 ISO 8601。
   */
  timeFormat: string;

  /**
   * M4 · EXT-19【官方无】：当前实例的命名空间。
   * 配置、状态库、去重键都按它隔离；默认 `default` 与 M1–M3 行为完全一致。
   */
  namespace: string;

  /** M4 · EXT-19【官方无】：只读管理页与受鉴权重发入口。 */
  admin: {
    /** 是否挂载 /admin 路由。只影响本地 HTTP 服务，不产生任何触发点。 */
    enabled: boolean;
    /** 管理接口鉴权 token；未设置时回退 HEALTHZ_TOKEN，仍为空则表示本机可信回环访问。 */
    token: string;
    /** 手动重发总开关，默认关闭；打开后还必须提供有效 token 才能调用。 */
    retryEnabled: boolean;
    /** 管理页每个列表最多返回多少条，防止大库把页面拖慢。 */
    maxRecords: number;
  };

  /** strict=true 时强制关闭全部 A 类扩展（spec §1 三条铁律）。 */
  strictMode: boolean;

  pollIntervalSeconds: number;
  /** 补发窗口，与官方 MAX_CATCH_UP_MS 一致，默认 5 分钟（BASE-27）。 */
  gracePeriodMs: number;
  catchUp: boolean;
  statePath: string;
  healthzPort: number;
  healthzToken: string;

  /** EXT-20【官方无】：日志级别，默认 info（输出量与 v1.12 及以前一致）。 */
  logLevel: LogLevel;
  /** 日志级别填了无法识别的值时的提示；空串表示配置有效。cli 启动时用 warn 打一次。 */
  logLevelWarning: string;

  officialRules: {
    taskReminderDefault: 'send' | 'skip';
    includeStart: boolean;
    includeDue: boolean;
    includeReview: boolean;
    includeReference: boolean;
    digest: {
      morning: DigestRule;
      evening: DigestRule;
      weekly: DigestRule;
    };
  };

  enhancements: {
    triggers: {
      dateOnly: DateOnlyRule;
      backlog: { enabled: boolean; minIntervalMs: number };
      quietHours: QuietHoursRule;
    };
    reliability: {
      pollFailureAlertAfter: number;
      maxBackoffMs: number;
    };
  };

  channels: {
    email: {
      enabled: boolean;
      host: string;
      port: number;
      secure: boolean;
      requireTls: boolean;
      user: string;
      password: string;
      from: string;
      fromName: string;
      to: string[];
    };
    webhook: {
      enabled: boolean;
      urls: string[];
      secret: string;
      maxAttempts: number;
    };
    privacy: {
      stripFields: string[];
      digestWithoutDescription: boolean;
    };
  };

  /** M3 扩展配置。全部属于【官方无】，能力开关默认关闭。 */
  m3: {
    /** 平台适配器：与 WEBHOOK_URLS 一一对应，缺省为 generic。 */
    adapters: {
      kinds: WebhookAdapter[];
      secrets: string[];
    };
  };
}

/** 极简 .env 解析：只认 KEY=VALUE，忽略注释与空行，不引入第三方依赖。 */
function readDotEnv(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

/**
 * 校验并归一化 `NOTIFY_TIME_FORMAT`。
 *
 * 判据刻意宽松：只要含**至少一个**已知 token（yyyy/MM/dd/HH/mm/ss）就照用，
 * 让 `MM-dd HH:mm`、`yyyy/MM/dd` 这类写法都能生效。
 * 一个 token 都没有（例如误填 `date`）时回退默认值 —— 否则消息里会出现一坨没有信息量的字面量。
 */
function normalizeTimeFormat(value: string | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_TIME_FORMAT;
  if (!/yyyy|MM|dd|HH|mm|ss/.test(text)) return DEFAULT_TIME_FORMAT;
  return text;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1' || value === 'yes';
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * 加载配置（M4 的 namespace 选择 / 分段配置属 EXT-19【官方无】，不改变任何 BASE 规则）。
 *
 * @param options.root      项目根目录，用于定位 .env 与默认状态库路径
 * @param options.env       环境变量源（测试时可注入假值）
 * @param options.overrides 显式覆盖，优先级最高（CLI 的 --strict 等开关走这里）
 */
export function loadConfig(options: {
  root?: string;
  env?: Record<string, string | undefined>;
  overrides?: Partial<NotifyConfig>;
} = {}): NotifyConfig {
  const root = options.root ?? process.cwd();
  const fileEnv = readDotEnv(resolve(root, '.env'));
  const injected = options.env ?? process.env;

  // 命名空间必须先确定：它决定读哪一段配置、状态库落在哪个文件、去重键加什么前缀。
  const namespace = normalizeNamespace(injected.NOTIFY_NAMESPACE ?? fileEnv.NOTIFY_NAMESPACE);

  // 可选 JSON 配置文件：只在显式指定时读取，避免意外覆盖环境变量。
  let fileConfig: Record<string, unknown> = {};
  const configPath = injected.NOTIFY_CONFIG ?? fileEnv.NOTIFY_CONFIG;
  if (configPath && existsSync(resolve(root, configPath))) {
    try {
      fileConfig = JSON.parse(readFileSync(resolve(root, configPath), 'utf8'));
    } catch {
      fileConfig = {}; // 配置写错时退回默认，不让服务起不来
    }
  }
  const fileBool = (key: string, fallback: boolean) =>
    typeof fileConfig[key] === 'boolean' ? fileConfig[key] as boolean : fallback;

  // M4「配置按 namespace 分开」：JSON 里的 namespaces.<ns> 段使用与 .env 相同的键名
  // （例如 NOTIFY_TIMEZONE / SMTP_ENABLED），只作用于该命名空间。
  // 优先级：进程/注入的 env > 命名空间段 > .env。这样临时改环境变量仍可覆盖分段配置。
  const namespaces = fileConfig.namespaces;
  const section = namespaces && typeof namespaces === 'object'
    ? (namespaces as Record<string, unknown>)[namespace]
    : undefined;
  const nsEnv: Record<string, string> = {};
  if (section && typeof section === 'object') {
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (value !== null && value !== undefined) nsEnv[key] = String(value);
    }
  }
  const env: Record<string, string | undefined> = { ...fileEnv, ...nsEnv, ...injected };

  // EXT-20【官方无】：日志级别。写错不该让服务起不来，所以回退到 info，
  // 并留一条启动告警让用户知道「为什么开了 debug 却没生效」。
  // 命令行 --log-level 的覆盖走 options.overrides，优先级最高（见文件头）。
  const rawLogLevel = env.NOTIFY_LOG_LEVEL;
  const parsedLogLevel = parseLogLevel(rawLogLevel);
  const logLevelWarning = rawLogLevel && !parsedLogLevel
    ? `NOTIFY_LOG_LEVEL="${redactUrls(rawLogLevel).slice(0, 40)}" 无法识别，已回退 info（可选：${LOG_LEVELS.join('/')}）`
    : '';

  const config: NotifyConfig = {
    baseUrl: String(env.MINDWTR_BASE_URL || 'https://mindwtr-cloud.zlay.dpdns.org').replace(/\/+$/, ''),
    token: String(env.MINDWTR_TOKEN || '').trim(),
    timezone: env.NOTIFY_TIMEZONE || 'Asia/Shanghai',
    timeFormat: normalizeTimeFormat(env.NOTIFY_TIME_FORMAT),
    namespace,
    strictMode: bool(env.NOTIFY_STRICT, fileBool('strictMode', false)),
    pollIntervalSeconds: number(env.NOTIFY_POLL_SECONDS, 60),
    gracePeriodMs: number(env.NOTIFY_GRACE_MS, 5 * 60_000),
    catchUp: bool(env.NOTIFY_CATCH_UP, true),
    // 非默认命名空间自动派生独立文件，避免两套实例写同一个 SQLite（EXT-19【官方无】）。
    statePath: statePathForNamespace(
      resolve(root, env.NOTIFY_STATE_PATH || 'data/notify.sqlite'), namespace),
    healthzPort: number(env.HEALTHZ_PORT, 8788),
    healthzToken: String(env.HEALTHZ_TOKEN || ''),
    logLevel: parsedLogLevel ?? 'info',
    logLevelWarning,

    admin: {
      enabled: bool(env.NOTIFY_ADMIN_PAGE, true),
      // 独立的管理 token 优先；没配就复用 /healthz 的 token，避免多一套凭据要维护。
      token: String(env.NOTIFY_ADMIN_TOKEN || env.HEALTHZ_TOKEN || '').trim(),
      // 手动重发会改变本地去重状态，默认关闭，且打开后仍强制要求 token。
      retryEnabled: bool(env.NOTIFY_ADMIN_RETRY, false),
      maxRecords: number(env.NOTIFY_ADMIN_MAX_RECORDS, 100),
    },

    officialRules: {
      taskReminderDefault: (env.NOTIFY_TASK_REMINDER_DEFAULT === 'skip' ? 'skip' : 'send'),
      includeStart: bool(env.NOTIFY_INCLUDE_START, true),
      includeDue: bool(env.NOTIFY_INCLUDE_DUE, true),
      includeReview: bool(env.NOTIFY_INCLUDE_REVIEW, true),
      includeReference: bool(env.NOTIFY_INCLUDE_REFERENCE, false),
      digest: {
        morning: { enabled: bool(env.NOTIFY_DIGEST_MORNING, true), at: '09:00' },
        evening: { enabled: bool(env.NOTIFY_DIGEST_EVENING, true), at: '20:00' },
        weekly: { enabled: bool(env.NOTIFY_DIGEST_WEEKLY, true), at: '18:00', day: 0 },
      },
    },

    enhancements: {
      triggers: {
        // A 类扩展默认全部关闭，保证默认行为与官方一致。
        dateOnly: { enabled: bool(env.NOTIFY_DATE_ONLY, false), at: '09:00' },
        backlog: { enabled: bool(env.NOTIFY_BACKLOG, false), minIntervalMs: 24 * 60 * 60_000 },
        quietHours: {
          enabled: bool(env.NOTIFY_QUIET_HOURS, false),
          start: '23:00', end: '08:00', defer: true,
        },
      },
      reliability: {
        pollFailureAlertAfter: number(env.NOTIFY_FAILURE_ALERT_AFTER, 3),
        maxBackoffMs: number(env.NOTIFY_MAX_BACKOFF_MS, 10 * 60_000),
      },
    },

    channels: {
      email: {
        enabled: bool(env.SMTP_ENABLED, false),
        host: String(env.SMTP_HOST || ''),
        port: number(env.SMTP_PORT, 587),
        secure: number(env.SMTP_PORT, 587) === 465,
        requireTls: bool(env.SMTP_REQUIRE_TLS, true),
        user: String(env.SMTP_USER || ''),
        password: String(env.SMTP_PASS || ''),
        from: String(env.SMTP_FROM || ''),
        fromName: String(env.SMTP_FROM_NAME || 'Notify'),
        to: list(env.SMTP_TO),
      },
      webhook: {
        enabled: bool(env.WEBHOOK_ENABLED, false),
        urls: list(env.WEBHOOK_URLS),
        secret: String(env.WEBHOOK_SECRET || ''),
        maxAttempts: number(env.WEBHOOK_MAX_ATTEMPTS, 3),
      },
      privacy: {
        stripFields: ['attachments', 'assignedTo', 'contexts', 'tags'],
        digestWithoutDescription: bool(env.NOTIFY_DIGEST_WITHOUT_DESCRIPTION, true),
      },
    },

    m3: {
      adapters: {
        kinds: list(env.NOTIFY_WEBHOOK_ADAPTERS).map(value => {
          const normalized = value.toLowerCase();
          return normalized === 'dingtalk' || normalized === 'wecom' || normalized === 'feishu'
            ? normalized
            : 'generic';
        }) as WebhookAdapter[],
        secrets: list(env.NOTIFY_WEBHOOK_SECRETS),
      },
    },
  };

  return { ...config, ...(options.overrides ?? {}) };
}

/**
 * 校验运行所需的最小配置。
 * 只读探测（--dry-run / --once）也需要 token；没有配置 SMTP/Webhook 不算错误，
 * 因为 dry-run 本来就不需要真实投递。
 */
export function validateConfig(config: NotifyConfig): string[] {
  const problems: string[] = [];
  if (!config.token) problems.push('缺少 MINDWTR_TOKEN（需要完整 bearer token）');
  if (!/^https?:\/\//.test(config.baseUrl)) problems.push('MINDWTR_BASE_URL 不是合法的 http(s) 地址');
  if (config.pollIntervalSeconds < 15) problems.push('轮询间隔不应低于 15 秒，避免给 Cloud API 造成压力');
  if (config.channels.email.enabled && (!config.channels.email.host || !config.channels.email.to.length)) {
    problems.push('邮件通道已启用，但缺少 SMTP_HOST 或 SMTP_TO');
  }
  if (config.channels.webhook.enabled && !config.channels.webhook.urls.length) {
    problems.push('Webhook 通道已启用，但缺少 WEBHOOK_URLS');
  }
  // M4：重发入口只有在「有 token + 显式开启」时才允许存在，防止出现无保护的写入口。
  if (config.admin.retryEnabled && !config.admin.token) {
    problems.push('NOTIFY_ADMIN_RETRY 已开启，但缺少 NOTIFY_ADMIN_TOKEN / HEALTHZ_TOKEN 鉴权凭据');
  }
  return problems;
}
