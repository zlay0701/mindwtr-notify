/**
 * 规则引擎单元测试
 *
 * 覆盖 spec §18 列出的六条「最容易写错」的基线规则，外加字段规范化和过滤逻辑。
 * 运行：npm test（等价于 node --test tests/reminder-plan.test.ts，零第三方依赖）
 *
 * 这里刻意只用内存里的假任务，不连接真实 Cloud API：
 * 规则是纯函数，应当在任何环境下得到完全相同的结果。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDueRepeatTimes,
  getTaskReminderPlan,
  getTaskReminderPolicy,
  hasTimeComponent,
  isTaskActionable,
  isTaskInArchivedProject,
  normalizeDueLeadMinutes,
  normalizeRepeatMinutes,
  normalizeStartLeadMinutes,
  shouldSendReminderKind,
  subtractLeadTime,
} from '../src/rules/reminder-plan.ts';
import type { MindwtrProject, MindwtrTask } from '../src/types.ts';

/** 构造一条最小任务，避免每个用例重复写一整套字段。 */
function makeTask(overrides: Partial<MindwtrTask> = {}): MindwtrTask {
  return { id: 'task-1', status: 'next', ...overrides };
}

/** 固定的 UTC 时刻，保证测试在任何时区运行结果一致。 */
const DUE_AT = Date.parse('2026-11-13T09:00:00Z');
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// BASE-21 / BASE-22：带时间判定
// ---------------------------------------------------------------------------

test('BASE-21 仅日期与带时间的判定，午夜 T00:00 算带时间', () => {
  assert.equal(hasTimeComponent('2026-11-13'), false);
  assert.equal(hasTimeComponent('2026-11-13T00:00'), true, 'T00:00 是最容易误判成仅日期的一条');
  assert.equal(hasTimeComponent('2026-11-13 09:30'), true);
  assert.equal(hasTimeComponent(undefined), false);
  assert.equal(hasTimeComponent(123), false);
});

// ---------------------------------------------------------------------------
// BASE-12：字段合法值
// ---------------------------------------------------------------------------

test('BASE-12 提前量与重复间隔的合法值', () => {
  assert.equal(normalizeDueLeadMinutes(1440), 1440);
  assert.equal(normalizeDueLeadMinutes(10080), 10080);
  assert.equal(normalizeDueLeadMinutes(10081), null);
  assert.equal(normalizeDueLeadMinutes(-5), null);
  assert.equal(normalizeDueLeadMinutes('30'), null);

  assert.equal(normalizeStartLeadMinutes(15), 15);
  assert.equal(normalizeStartLeadMinutes(45), null, 'start 提前量只接受 0/5/15/30/60');
  assert.equal(normalizeStartLeadMinutes(1440), null);

  assert.equal(normalizeRepeatMinutes(60), 60);
  assert.equal(normalizeRepeatMinutes(7), null);
});

// ---------------------------------------------------------------------------
// BASE-25：重复提醒次数公式
// ---------------------------------------------------------------------------

test('BASE-25 重复次数是 min(8, floor(120/interval))，不是固定 8 次', () => {
  assert.equal(getDueRepeatTimes(DUE_AT, 5).length, 8);
  assert.equal(getDueRepeatTimes(DUE_AT, 30).length, 4);
  assert.equal(getDueRepeatTimes(DUE_AT, 60).length, 2, '60 分钟间隔实际只有 2 次');
  assert.deepEqual(getDueRepeatTimes(DUE_AT, 7), [], '非法间隔不产生重复提醒');

  const times = getDueRepeatTimes(DUE_AT, 30);
  assert.deepEqual(times, [
    DUE_AT + 30 * MINUTE,
    DUE_AT + 60 * MINUTE,
    DUE_AT + 90 * MINUTE,
    DUE_AT + 120 * MINUTE,
  ]);
});

// ---------------------------------------------------------------------------
// BASE-23：提前量算术
// ---------------------------------------------------------------------------

test('BASE-23 分钟级提前量减毫秒，整天提前量按日历日回退', () => {
  assert.equal(subtractLeadTime(DUE_AT, 30), DUE_AT - 30 * MINUTE);
  assert.equal(
    subtractLeadTime(DUE_AT, 1440),
    Date.parse('2026-11-12T09:00:00Z'),
    '提前 1 天仍是同一本地时刻',
  );
  assert.equal(subtractLeadTime(DUE_AT, 2880), Date.parse('2026-11-11T09:00:00Z'));
});

// ---------------------------------------------------------------------------
// BASE-16 / BASE-17：策略解析
// ---------------------------------------------------------------------------

test('BASE-16 策略优先级：显式值 > 旧字段回退 > 默认 send', () => {
  assert.equal(getTaskReminderPolicy(makeTask({ reminderPolicy: 'skip' })), 'skip');
  assert.equal(getTaskReminderPolicy(makeTask({ reminderPolicy: 'due' })), 'due');
  assert.equal(getTaskReminderPolicy(makeTask({ suppressMindwtrReminders: true })), 'skip');
  assert.equal(getTaskReminderPolicy(makeTask()), 'send');
});

test('BASE-17 只有 inherit 跟随全局默认，字段缺失仍是 send', () => {
  assert.equal(getTaskReminderPolicy(makeTask({ reminderPolicy: 'inherit' }), 'skip'), 'skip');
  assert.equal(getTaskReminderPolicy(makeTask(), 'skip'), 'send', '字段缺失不等于 inherit');
});

// ---------------------------------------------------------------------------
// BASE-18 / BASE-19：skip 与单一策略
// ---------------------------------------------------------------------------

test('BASE-18 skip 撤销 due/start，但 review 仍然触发', () => {
  assert.equal(shouldSendReminderKind('skip', 'due'), false);
  assert.equal(shouldSendReminderKind('skip', 'start'), false);
  assert.equal(shouldSendReminderKind('skip', 'due-repeat'), false);
  assert.equal(shouldSendReminderKind('skip', 'review'), true);
  assert.equal(shouldSendReminderKind('skip', 'digest-morning'), true, '摘要不受任务策略影响');
});

test('BASE-19 单一策略配了提前量时，普通提醒被抑制', () => {
  assert.equal(shouldSendReminderKind('start', 'start'), true);
  assert.equal(shouldSendReminderKind('start', 'due'), false);
  assert.equal(shouldSendReminderKind('start', 'start', { startLeadConfigured: true }), false);
  assert.equal(shouldSendReminderKind('start', 'start-advance', { startLeadConfigured: true }), true);
  assert.equal(shouldSendReminderKind('due', 'due', { dueLeadConfigured: true }), false);
  assert.equal(shouldSendReminderKind('due', 'due-advance', { dueLeadConfigured: true }), true);
});

// ---------------------------------------------------------------------------
// BASE-28：过滤
// ---------------------------------------------------------------------------

test('BASE-28 只有四个活跃状态参与调度，完成/取消/删除一律排除', () => {
  assert.equal(isTaskActionable(makeTask({ status: 'inbox' })), true);
  assert.equal(isTaskActionable(makeTask({ status: 'waiting' })), true);
  assert.equal(isTaskActionable(makeTask({ status: 'done' })), false);
  assert.equal(isTaskActionable(makeTask({ status: 'archived' })), false);
  assert.equal(isTaskActionable(makeTask({ status: 'reference' })), false);
  assert.equal(isTaskActionable(makeTask({ status: 'next', cancelledAt: '2026-11-13T08:00:00Z' })), false);
  assert.equal(isTaskActionable(makeTask({ status: 'next', completedAt: '2026-11-13T08:00:00Z' })), false);
  assert.equal(isTaskActionable(makeTask({ status: 'next', deletedAt: '2026-11-13T08:00:00Z' })), false);
});

test('BASE-28 归档项目过滤：缓存缺失时保守放行', () => {
  const projects = new Map<string, MindwtrProject>([
    ['p-archived', { id: 'p-archived', status: 'archived' }],
    ['p-active', { id: 'p-active', status: 'active' }],
  ]);

  assert.equal(isTaskInArchivedProject(makeTask({ projectArchivedAt: '2026-11-01T00:00:00Z' }), projects), true);
  assert.equal(isTaskInArchivedProject(makeTask({ projectId: 'p-archived' }), projects), true);
  assert.equal(isTaskInArchivedProject(makeTask({ projectId: 'p-active' }), projects), false);
  assert.equal(isTaskInArchivedProject(makeTask({ projectId: 'p-missing' }), projects), false, '查不到项目时放行');
});

// ---------------------------------------------------------------------------
// 触发计划整体
// ---------------------------------------------------------------------------

test('完整任务生成 due / due-advance / due-repeat，且按时间升序', () => {
  const task = makeTask({
    dueDate: '2026-11-13T09:00:00Z',
    dueReminderLeadMinutes: 30,
    repeatReminderMinutes: 60,
  });
  const plan = getTaskReminderPlan(task);

  assert.deepEqual(plan.map(item => item.kind), [
    'due-advance', 'due', 'due-repeat', 'due-repeat',
  ]);
  assert.equal(plan[0].scheduledAt, DUE_AT - 30 * MINUTE);
  assert.equal(plan[0].leadMinutes, 30);
  assert.deepEqual(plan.map(item => item.repeatIndex).filter(Boolean), [1, 2]);
  assert.deepEqual(plan.map(item => item.scheduledAt), [...plan.map(item => item.scheduledAt)].sort((a, b) => a - b));
});

test('BASE-22 仅日期任务不产生任何任务级触发点', () => {
  const plan = getTaskReminderPlan(makeTask({ dueDate: '2026-11-13', startTime: '2026-11-13' }));
  assert.deepEqual(plan, []);
});

test('skip 任务仍保留 review 触发点', () => {
  const plan = getTaskReminderPlan(makeTask({
    reminderPolicy: 'skip',
    dueDate: '2026-11-13T09:00:00Z',
    reviewAt: '2026-11-14T09:00:00Z',
  }));
  assert.deepEqual(plan.map(item => item.kind), ['review']);
});

test('BASE-20 设备级开关可以单独关掉截止类提醒', () => {
  const plan = getTaskReminderPlan(
    makeTask({ dueDate: '2026-11-13T09:00:00Z', reviewAt: '2026-11-14T09:00:00Z' }),
    { includeDue: false },
  );
  assert.deepEqual(plan.map(item => item.kind), ['review']);
});

// ---------------------------------------------------------------------------
// BASE-06 / BASE-18：review 独立于任务策略
// ---------------------------------------------------------------------------

test('BASE-06 review 不受 start / due 单一策略影响，仍会触发', () => {
  // start 单一策略 + 提前量：普通 start 被抑制，但 review 仍保留
  const startPlan = getTaskReminderPlan(
    makeTask({
      reminderPolicy: 'start',
      startTime: '2026-11-13T09:00:00Z',
      reviewAt: '2026-11-14T09:00:00Z',
      startReminderLeadMinutes: 60,
    }),
  );
  assert.deepEqual(startPlan.map(item => item.kind), ['start-advance', 'review']);

  // due 单一策略 + 提前量：基础 due 被抑制、不排 due-repeat，但 review 仍保留
  const duePlan = getTaskReminderPlan(
    makeTask({
      reminderPolicy: 'due',
      dueDate: '2026-11-13T09:00:00Z',
      reviewAt: '2026-11-14T09:00:00Z',
      dueReminderLeadMinutes: 30,
      repeatReminderMinutes: 60,
    }),
  );
  assert.deepEqual(duePlan.map(item => item.kind), ['due-advance', 'review']);
});

test('BASE-19 单一 due 策略下不排 due-repeat（对齐官方 isSingleTaskReminder）', () => {
  const plan = getTaskReminderPlan(
    makeTask({
      reminderPolicy: 'due',
      dueDate: '2026-11-13T09:00:00Z',
      dueReminderLeadMinutes: 30,
      repeatReminderMinutes: 60,
    }),
  );
  // 配了提前量：仅 due-advance；即便设了 repeatReminderMinutes 也不排 due-repeat
  assert.deepEqual(plan.map(item => item.kind), ['due-advance']);
});
