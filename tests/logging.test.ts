/**
 * 分级日志测试（v1.13 · EXT-20【官方无】）
 *
 * 覆盖：级别解析与过滤、输出格式、URL/凭据脱敏、配置加载与命令行覆盖、
 * 调度器诊断日志、以及「旧的 log 单函数注入」的向后兼容。
 *
 * 全部用注入的 sink / 假 fetch / 假状态库，不产生任何外部请求，也不污染测试输出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { createCloudClient } from '../src/cloud/client.ts';
import { describeError, redactUrls } from '../src/errors.ts';
import { createLogger, LOG_LEVELS, parseLogLevel, type EmitLevel, type LogLevel } from '../src/logger.ts';
import { createScheduler } from '../src/scheduler.ts';
import { createStateStore } from '../src/state/store.ts';

/** 收集日志行，返回 sink 与数组，测试里只断言数组内容。 */
function capture(level: LogLevel) {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    timezone: 'UTC',
    now: () => new Date('2026-11-15T12:34:56Z'),
    sink: (line: string) => lines.push(line),
  });
  return { logger, lines };
}

/** 构造不读取本机 .env 的测试配置。 */
function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    root: '/nonexistent-notify-root',
    env: { MINDWTR_TOKEN: 'test-token', MINDWTR_BASE_URL: 'https://example.invalid', ...env },
  });
}

// ---------------------------------------------------------------------------
// 级别解析
// ---------------------------------------------------------------------------

test('parseLogLevel：五个合法值、大小写与空格容错，非法值返回 null', () => {
  for (const level of LOG_LEVELS) assert.equal(parseLogLevel(level), level);
  assert.equal(parseLogLevel('DEBUG'), 'debug');
  assert.equal(parseLogLevel('  Info  '), 'info');
  assert.equal(parseLogLevel(''), null);
  assert.equal(parseLogLevel(undefined), null);
  assert.equal(parseLogLevel('verbose'), null);
  assert.equal(parseLogLevel('trace'), null);
});

// ---------------------------------------------------------------------------
// 输出过滤与格式
// ---------------------------------------------------------------------------

test('createLogger：debug 级别输出全部四级，其余级别按顺序收窄', () => {
  const cases: Array<{ level: LogLevel; expected: EmitLevel[] }> = [
    { level: 'debug', expected: ['debug', 'info', 'warn', 'error'] },
    { level: 'info', expected: ['info', 'warn', 'error'] },
    { level: 'warn', expected: ['warn', 'error'] },
    { level: 'error', expected: ['error'] },
    { level: 'silent', expected: [] },
  ];
  for (const item of cases) {
    const { logger, lines } = capture(item.level);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    assert.equal(lines.length, item.expected.length, `${item.level} 应输出 ${item.expected.length} 行`);
    for (const at of item.expected) {
      assert.ok(lines.some(line => line.includes(`[${at.toUpperCase().padEnd(5)}]`)), `${item.level} 应包含 ${at}`);
    }
  }
});

test('输出格式：UTC 时间戳 + 级别 + 前缀 + 结构化字段', () => {
  const { logger, lines } = capture('debug');
  logger.info('本轮完成', { planned: 4, sent: 1, channel: 'webhook:0', skipped: null });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^2026-11-15 12:34:56 \[INFO \] \[notify\] 本轮完成 /);
  assert.ok(lines[0].includes('planned=4'), '数字字段直接输出');
  assert.ok(lines[0].includes('sent=1'));
  assert.ok(lines[0].includes('channel=webhook:0'));
  assert.ok(!lines[0].includes('skipped='), 'null 字段应被跳过');
});

test('enabled 与实际输出一致，silent 下所有级别都关闭', () => {
  const { logger } = capture('info');
  assert.equal(logger.enabled('debug'), false);
  assert.equal(logger.enabled('info'), true);
  assert.equal(logger.enabled('warn'), true);
  assert.equal(logger.enabled('error'), true);
  assert.equal(logger.level, 'info');

  const silent = capture('silent').logger;
  for (const at of ['debug', 'info', 'warn', 'error'] as EmitLevel[]) {
    assert.equal(silent.enabled(at), false);
  }
});

// ---------------------------------------------------------------------------
// 安全：URL 与凭据一律脱敏
// ---------------------------------------------------------------------------

test('redactUrls 把 http(s) 地址整段替换成 [url]', () => {
  assert.equal(redactUrls('fetch failed: https://hook.example.invalid/a?token=SECRET'), 'fetch failed: [url]');
  assert.equal(redactUrls('GET http://127.0.0.1:8787/health 失败'), 'GET [url] 失败');
  assert.equal(redactUrls('普通文本保持原样'), '普通文本保持原样');
});

test('describeError 在 message 为空时用 error.code 兜底', () => {
  // 背景：Bun 下 socket 错误的 message 是空串，但 code 仍是 ECONNREFUSED。
  // 若不看 code，VPS 端口被封这类失败只会显示「未知错误」，无法区分拒绝与超时。
  const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
  assert.equal(describeError(refused), '网络/系统错误（ECONNREFUSED）');

  // 有 message 时仍以 message 为准，不受 code 影响
  const withMessage = Object.assign(new Error('连接被拒绝'), { code: 'ECONNREFUSED' });
  assert.equal(describeError(withMessage), '连接被拒绝');

  // 既无 message 又无 code 时，落到调用方给的兜底文案
  assert.equal(describeError(new Error('')), '未知错误');
  assert.equal(describeError(new Error(''), 'SMTP 发送失败（未提供错误详情）'), 'SMTP 发送失败（未提供错误详情）');
});

test('日志正文与结构化字段里的密钥 URL 都不会出现在输出里', () => {
  const { logger, lines } = capture('debug');
  const secretUrl = 'https://hook.example.invalid/notify?token=SECRET_VALUE_123';
  logger.error(`投递失败：${secretUrl}`, { target: secretUrl, reason: 'HTTP 500' });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('[url]'), 'URL 已替换为占位符');
  assert.ok(!lines[0].includes('SECRET_VALUE_123'), '密钥不落日志');
  assert.ok(!lines[0].includes('hook.example.invalid'), '域名也不落日志');
});

// ---------------------------------------------------------------------------
// 配置：环境变量、非法值回退、命令行覆盖
// ---------------------------------------------------------------------------

test('loadConfig：默认 info，NOTIFY_LOG_LEVEL 可设 debug，非法值回退并给出告警', () => {
  assert.equal(testConfig().logLevel, 'info');
  assert.equal(testConfig().logLevelWarning, '');

  const debug = testConfig({ NOTIFY_LOG_LEVEL: ' DEBUG ' });
  assert.equal(debug.logLevel, 'debug');
  assert.equal(debug.logLevelWarning, '');

  const bad = testConfig({ NOTIFY_LOG_LEVEL: 'verbose' });
  assert.equal(bad.logLevel, 'info', '写错级别不能让服务起不来');
  assert.ok(bad.logLevelWarning.includes('回退 info'));
  assert.ok(bad.logLevelWarning.includes('debug'));
});

test('loadConfig：非法值告警本身也会脱敏，不会把 URL 带进日志', () => {
  const bad = testConfig({ NOTIFY_LOG_LEVEL: 'https://hook.example.invalid/?token=SECRET_VALUE_123' });
  assert.ok(bad.logLevelWarning.includes('[url]'));
  assert.ok(!bad.logLevelWarning.includes('SECRET_VALUE_123'));
});

test('loadConfig：命令行覆盖优先级最高，并清掉 .env 的非法值告警', () => {
  const config = loadConfig({
    root: '/nonexistent-notify-root',
    env: {
      MINDWTR_TOKEN: 'test-token',
      MINDWTR_BASE_URL: 'https://example.invalid',
      NOTIFY_LOG_LEVEL: 'verbose',
    },
    overrides: { logLevel: 'silent', logLevelWarning: '' },
  });
  assert.equal(config.logLevel, 'silent');
  assert.equal(config.logLevelWarning, '');
});

// ---------------------------------------------------------------------------
// 集成：调度器与 Cloud 客户端
// ---------------------------------------------------------------------------

/** 构造一轮 dry-run 所需的最小依赖；不联网、不投递、不写业务数据。 */
async function runSchedulerRound(level: LogLevel, extra: { legacyLog?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-log-'));
  const { logger, lines } = capture(level);
  const store = await createStateStore(join(dir, 'state.sqlite'));
  const config = testConfig({ NOTIFY_LOG_LEVEL: level });

  const cloud = {
    fetchActiveTasks: async () => ({ items: [], total: 0, pages: 0, stoppedBy: 'exhausted' }),
    fetchProjects: async () => [],
    recordSuccess: () => ({ failures: 0, recovered: false }),
    recordFailure: () => ({ failures: 1 }),
    nextDelayMs: () => 60_000,
    lastError: () => '',
    health: async () => true,
  };
  const dispatcher = {
    channels: [],
    deliverChannel: async () => ({ ok: true, attempts: 1 }),
    deliver: async () => ({}),
  };

  const scheduler = createScheduler({
    config,
    cloud: cloud as never,
    store,
    dispatcher: dispatcher as never,
    now: () => Date.parse('2026-11-15T12:34:56Z'),
    logger,
    ...(extra.legacyLog ? { log: (message: string) => extra.legacyLog!.push(message) } : {}),
  });

  try {
    await scheduler.runOnce({ dryRun: true, strict: true });
    return lines;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('调度器：debug 级别能看到轮次 / 拉取 / 计划诊断，info 级别看不到', async () => {
  const debugLines = await runSchedulerRound('debug');
  assert.ok(debugLines.some(line => line.includes('开始新一轮调度')), 'debug 应记录轮次开始');
  assert.ok(debugLines.some(line => line.includes('计划生成完成')), 'debug 应记录计划条数');

  const infoLines = await runSchedulerRound('info');
  assert.equal(infoLines.some(line => line.includes('[DEBUG]')), false, 'info 不得输出 debug 行');
});

test('调度器：兼容旧的 log 单函数注入，debug 诊断不会混进去', async () => {
  const collected: string[] = [];
  const lines = await runSchedulerRound('debug', { legacyLog: collected });
  assert.equal(lines.length, 0, '注入 log 时不再写 logger.sink');
  assert.equal(collected.length, 0, 'dry-run 且注入 log 时，info 与 debug 都不进旧注入点');
});

test('Cloud 客户端：debug 记录请求路径与耗时，但绝不打印 token', async () => {
  const { logger, lines } = capture('debug');
  const config = testConfig({ MINDWTR_TOKEN: 'FULL_BEARER_SECRET_999' });
  const fakeFetch = (async () => new Response('{"tasks":[],"total":0}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

  const client = createCloudClient(config, fakeFetch, logger);
  await client.fetchActiveTasks();

  assert.ok(lines.some(line => line.includes('Cloud GET 开始') && line.includes('/v1/tasks')));
  assert.ok(lines.some(line => line.includes('Cloud GET 完成') && line.includes('ms=')));
  assert.ok(!lines.join('\n').includes('FULL_BEARER_SECRET_999'), 'token 不能出现在任何日志里');
  assert.ok(!lines.join('\n').includes('example.invalid'), 'Cloud 地址也不写进日志');
});
