/**
 * M2 规则层测试：配置、时区、三类摘要、A 类扩展、strict 隔离
 *
 * 全部用内存数据，不打真实 API，保证任何环境下结果一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateConfig } from '../src/config.ts';
import { buildPlan } from '../src/rules/plan.ts';
import { buildDigestPayload } from '../src/rules/plan.ts';
import { getZonedParts, zonedTimeToEpoch } from '../src/rules/time.ts';
import type { MindwtrTask } from '../src/types.ts';

/** 构造测试配置：注入假的 token，不读本机 .env。 */
function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    root: '/nonexistent-notify-root',
    env: { MINDWTR_TOKEN: 'test-token', ...overrides },
  });
}

/** 构造一条最小任务。 */
function makeTask(id: string, fields: Partial<MindwtrTask> = {}): MindwtrTask {
  return { id, status: 'next', ...fields };
}

/** 固定的 UTC 时刻：2026-11-13 01:00Z，对应北京时间 09:00。 */
const NOW = Date.parse('2026-11-13T01:00:00Z');
const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('配置默认值：A 类扩展全关、补发窗口 5 分钟、strict 关闭', () => {
  const config = testConfig();
  assert.equal(config.channels.email.enabled, false);
  assert.equal(config.channels.webhook.enabled, false);
  assert.equal(config.enhancements.triggers.dateOnly.enabled, false);
  assert.equal(config.enhancements.triggers.backlog.enabled, false);
  assert.equal(config.enhancements.triggers.quietHours.enabled, false);
  assert.equal(config.gracePeriodMs, 300_000);
  assert.equal(config.strictMode, false);
  assert.equal(config.officialRules.digest.morning.at, '09:00');
});

test('配置校验：缺 token 报错，未启用渠道时不要求 SMTP', () => {
  const missing = loadConfig({ root: '/nonexistent-notify-root', env: {} });
  assert.ok(validateConfig(missing).some(text => text.includes('MINDWTR_TOKEN')));
  assert.deepEqual(validateConfig(testConfig()), []);
});

// ---------------------------------------------------------------------------
// 时区
// ---------------------------------------------------------------------------

test('时区换算：UTC 01:00 在北京时间是当天 09:00', () => {
  const parts = getZonedParts(NOW, TZ);
  assert.equal(parts.dateKey, '2026-11-13');
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 0);
});

test('本地时刻转 UTC：北京时间 09:00 等于 01:00Z', () => {
  assert.equal(zonedTimeToEpoch('2026-11-13', 9, 0, TZ), NOW);
});

// ---------------------------------------------------------------------------
// 三类摘要（BASE-08…10）
// ---------------------------------------------------------------------------

test('摘要内容：今日到期 / 已逾期 / 今日开始 / 专注任务分类正确', () => {
  const tasks = [
    makeTask('a', { dueDate: '2026-11-13T18:00:00Z' }),   // 北京时间 11-14 02:00 → 明日
    makeTask('b', { dueDate: '2026-11-12T10:00:00Z' }),   // 逾期
    makeTask('c', { dueDate: '2026-11-13T02:00:00Z' }),   // 今日
    makeTask('d', { startTime: '2026-11-13T03:00:00Z', isFocusedToday: true }),
  ];
  const payload = buildDigestPayload(tasks, NOW, TZ);
  assert.deepEqual(payload.dueToday.map(item => item.id), ['c']);
  assert.deepEqual(payload.overdue.map(item => item.id), ['b']);
  assert.deepEqual(payload.startingToday.map(item => item.id), ['d']);
  assert.deepEqual(payload.focused.map(item => item.id), ['d']);
  // 摘要条目不含 description 等正文字段（EXT-03）。
  assert.equal('description' in payload.dueToday[0], false);
});

test('晨间简报在触发窗口内生成，去重键是 kind + 日期（BASE-29）', () => {
  const config = testConfig();
  const plan = buildPlan({
    tasks: [], projects: new Map(), config, now: NOW, strict: false,
    store: { getMeta: () => null },
  });
  const morning = plan.find(item => item.kind === 'digest-morning');
  assert.ok(morning, '北京时间 09:00 应触发晨间简报');
  assert.equal(morning.dedupeKey, 'digest-morning:2026-11-13');
  assert.ok(morning.digest, '应带摘要内容');
  assert.equal(plan.some(item => item.kind === 'digest-evening'), false);
});

// ---------------------------------------------------------------------------
// A 类扩展（默认关闭，strict 强制关闭）
// ---------------------------------------------------------------------------

test('EXT-16 仅日期提醒默认不产生；开启后只在 09:00 汇总一条', () => {
  const tasks = [makeTask('t1', { dueDate: '2026-11-13' })];
  const base = { tasks, projects: new Map(), now: NOW, store: { getMeta: () => null } };

  const off = buildPlan({ ...base, config: testConfig(), strict: false });
  assert.equal(off.some(item => item.kind === 'date-only'), false);

  const config = testConfig();
  config.enhancements.triggers.dateOnly.enabled = true;
  const on = buildPlan({ ...base, config, strict: false });
  const item = on.find(entry => entry.kind === 'date-only');
  assert.ok(item);
  assert.equal(item.digest?.dueToday.length, 1);
  assert.equal(item.dedupeKey, 'date-only:2026-11-13');
});

test('EXT-16 判定沿用官方正则：T00:00 算带时间，不算仅日期', () => {
  const config = testConfig();
  config.enhancements.triggers.dateOnly.enabled = true;
  const plan = buildPlan({
    tasks: [makeTask('t', { dueDate: '2026-11-13T00:00' })],
    projects: new Map(), config, now: NOW, strict: false,
    store: { getMeta: () => null },
  });
  assert.equal(plan.some(item => item.kind === 'date-only'), false);
});

test('strict 模式强制关闭 A 类扩展，但保留三类摘要基线', () => {
  const config = testConfig();
  config.enhancements.triggers.dateOnly.enabled = true;
  config.enhancements.triggers.backlog.enabled = true;
  const plan = buildPlan({
    tasks: [makeTask('t', { dueDate: '2026-11-01T00:00:00Z' })],
    projects: new Map(), config, now: NOW, strict: true,
    store: { getMeta: () => null },
  });
  assert.equal(plan.some(item => item.kind === 'date-only'), false);
  assert.equal(plan.some(item => item.kind === 'backlog'), false);
  assert.equal(plan.some(item => item.kind === 'digest-morning'), true);
});

test('EXT-17 backlog 受 24 小时节流', () => {
  const config = testConfig();
  config.enhancements.triggers.backlog.enabled = true;
  const base = {
    tasks: [makeTask('t', { dueDate: '2026-11-01T00:00:00Z' })],
    projects: new Map(), config, now: NOW, strict: false,
  };
  const fresh = buildPlan({ ...base, store: { getMeta: () => null } });
  assert.equal(fresh.some(item => item.kind === 'backlog'), true);

  const recent = buildPlan({ ...base, store: { getMeta: () => String(NOW - 60_000) } });
  assert.equal(recent.some(item => item.kind === 'backlog'), false, '一分钟前刚发过就不再推');
});

test('EXT-18 静默时段把落在窗口内的触发点顺延', () => {
  const config = testConfig();
  config.enhancements.triggers.quietHours.enabled = true;
  const plan = buildPlan({
    tasks: [], projects: new Map(), config, now: NOW, strict: false,
    store: { getMeta: () => null },
  });
  // 09:00 不在 23:00–08:00 窗口内，时刻应保持不变。
  const morning = plan.find(item => item.kind === 'digest-morning');
  assert.ok(morning);
  assert.equal(morning.scheduledAt, zonedTimeToEpoch('2026-11-13', 9, 0, TZ));
});
