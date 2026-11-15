/**
 * 黄金数据集合比对夹具（目标 A / spec §18.2）
 *
 * 把官方 packages/core/src/schedule-utils.ts 的规则（见 tests/official-schedule.ts，逐字移植）作为基准，
 * 用同一份任务数据分别跑：
 *   - 官方 officialGetTaskReminderPlanTuples（枚举生命周期内全部触发点）
 *   - Notify 的 getTaskReminderPlan
 * 按 (task_id, kind, scheduledAt) 集合比对，strict 模式（仅 BASE 任务级触发点）差集必须为空。
 *
 * 全程纯函数、零网络、零依赖；本文件强制在 UTC 下运行（见文件顶部）：
 *   - 对齐 Notify 服务器实际时区（Docker 用 UTC）；
 *   - 消除官方 due-advance 用本地 setDate、Notify 用 setUTCDate 在跨 DST 时的日历日差异。
 */

// 必须在任何 Date 操作之前锁定 UTC（Node 懒加载时区，模块顶层设置即可生效）。
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getTaskReminderPlan } from '../src/rules/reminder-plan.ts';
import type { MindwtrTask, ReminderPlanOptions } from '../src/types.ts';
import {
  officialGetTaskReminderPlanTuples,
  type ScheduleOptions,
  type TriggerTuple,
} from './official-schedule.ts';

/** 确认本测试确实运行在 UTC 下（否则 due-advance 日历日结果会与官方不一致）。 */
test('黄金夹具运行环境：TZ=UTC 生效', () => {
  assert.equal(
    Date.parse('2026-11-13T09:00'),
    Date.parse('2026-11-13T09:00:00Z'),
    'local 解析必须等于 Z 解析，说明 TZ=UTC 已生效',
  );
});

/** 把 Notify 的触发点扁平化成 (task_id, kind, scheduledAt) 元组。 */
function notifyTuples(task: MindwtrTask, options: ReminderPlanOptions): TriggerTuple[] {
  return getTaskReminderPlan(task, options).map((t) => ({
    taskId: task.id,
    kind: t.kind,
    scheduledAt: t.scheduledAt,
  }));
}

/** 把两组元组规范化为「按 (scheduledAt, kind) 排序的键集合」，返回差集。 */
function diffTuples(a: TriggerTuple[], b: TriggerTuple[]): { onlyNotify: string[]; onlyOfficial: string[] } {
  const keyOf = (t: TriggerTuple): string => `${t.taskId}|${t.kind}|${t.scheduledAt}`;
  const setA = new Map(a.map((t) => [keyOf(t), t]));
  const setB = new Map(b.map((t) => [keyOf(t), t]));
  const onlyNotify: string[] = [];
  const onlyOfficial: string[] = [];
  for (const [k] of setA) if (!setB.has(k)) onlyNotify.push(k);
  for (const [k] of setB) if (!setA.has(k)) onlyOfficial.push(k);
  return { onlyNotify, onlyOfficial };
}

// ---------------------------------------------------------------------------
// 黄金数据集：覆盖 BASE-12 / 16 / 17 / 18 / 19 / 21 / 22 / 23 / 25 / 28 的易错点
// 每条 case 同时给出 Notify 的 ReminderPlanOptions 与官方的 ScheduleOptions（语义一一对应）。
// ---------------------------------------------------------------------------

const SEND = 'send';

interface GoldenCase {
  name: string;
  task: MindwtrTask;
  notify: ReminderPlanOptions;
  official: ScheduleOptions;
}

const cases: GoldenCase[] = [
  {
    name: 'BASE-22 仅日期不产生任何任务级触发点',
    task: { id: 't-dateonly', status: 'next', dueDate: '2026-11-13', startTime: '2026-11-13' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-21 T00:00 算带时间',
    task: { id: 't-t0000', status: 'next', dueDate: '2026-11-13T00:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-25 重复间隔 5 分钟 → 8 次',
    task: { id: 't-rep5', status: 'next', dueDate: '2026-11-13T09:00', repeatReminderMinutes: 5 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-25 重复间隔 30 分钟 → 4 次',
    task: { id: 't-rep30', status: 'next', dueDate: '2026-11-13T09:00', repeatReminderMinutes: 30 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-25 重复间隔 60 分钟 → 2 次',
    task: { id: 't-rep60', status: 'next', dueDate: '2026-11-13T09:00', repeatReminderMinutes: 60 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-23/04 due-advance 提前 1 天（日历日）',
    task: { id: 't-adv1d', status: 'next', dueDate: '2026-11-13T09:00', dueReminderLeadMinutes: 1440 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-23/04 due-advance 提前 2 天（日历日）',
    task: { id: 't-adv2d', status: 'next', dueDate: '2026-11-13T09:00', dueReminderLeadMinutes: 2880 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-23/04 due-advance 提前 7 天（10080 分钟）',
    task: { id: 't-adv7d', status: 'next', dueDate: '2026-11-13T09:00', dueReminderLeadMinutes: 10080 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-02 start-advance 提前 60 分钟（分钟级）',
    task: { id: 't-start', status: 'next', startTime: '2026-11-13T09:00', startReminderLeadMinutes: 60 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-06 review 仅受设备开关控制',
    task: { id: 't-review', status: 'next', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-18 skip 撤销 due/start，但保留 review',
    task: { id: 't-skip', status: 'next', reminderPolicy: 'skip', dueDate: '2026-11-13T09:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-19 单一 start 策略 + 提前量：仅 start-advance，但仍发 review',
    task: {
      id: 't-startpol',
      status: 'next',
      reminderPolicy: 'start',
      startTime: '2026-11-13T09:00',
      dueDate: '2026-11-14T09:00',
      reviewAt: '2026-11-15T09:00',
      startReminderLeadMinutes: 60,
    },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-19 单一 due 策略 + 提前量 + 重复：仅 due-advance，不排 due-repeat',
    task: {
      id: 't-duepol',
      status: 'next',
      reminderPolicy: 'due',
      dueDate: '2026-11-13T09:00',
      dueReminderLeadMinutes: 1440,
      repeatReminderMinutes: 60,
    },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'send 全量：due/due-advance/due-repeat/start/start-advance/review',
    task: {
      id: 't-full',
      status: 'next',
      dueDate: '2026-11-13T09:00',
      startTime: '2026-11-13T10:00',
      reviewAt: '2026-11-14T09:00',
      dueReminderLeadMinutes: 30,
      startReminderLeadMinutes: 15,
      repeatReminderMinutes: 30,
    },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-17 inherit → 全局 send',
    task: { id: 't-inherit-send', status: 'next', reminderPolicy: 'inherit', dueDate: '2026-11-13T09:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-17 inherit → 全局 skip（仍发 review）',
    task: { id: 't-inherit-skip', status: 'next', reminderPolicy: 'inherit', dueDate: '2026-11-13T09:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: 'skip' },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: 'skip' },
  },
  {
    name: 'BASE-16 旧字段 suppressMindwtrReminders → skip（仍发 review）',
    task: { id: 't-suppress', status: 'next', suppressMindwtrReminders: true, dueDate: '2026-11-13T09:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-20 设备级开关 includeDue=false 关掉截止类',
    task: { id: 't-nodue', status: 'next', dueDate: '2026-11-13T09:00', startTime: '2026-11-13T10:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: false, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: false, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-20 设备级开关 includeStart=false 关掉开始类',
    task: { id: 't-nostart', status: 'next', startTime: '2026-11-13T10:00', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: false, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: false, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-20 设备级开关 includeReview=false 关掉回顾类',
    task: { id: 't-noreview', status: 'next', dueDate: '2026-11-13T09:00', reviewAt: '2026-11-14T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: false, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: false, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-28 已完成状态不排',
    task: { id: 't-done', status: 'done', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-28 已归档状态不排',
    task: { id: 't-arch', status: 'archived', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-28 reference 状态不排',
    task: { id: 't-ref', status: 'reference', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-28 已删除（deletedAt）不排',
    task: { id: 't-del', status: 'next', deletedAt: '2026-11-01T00:00:00Z', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: 'BASE-12 非法提前量/重复间隔按未设置处理',
    task: { id: 't-badlead', status: 'next', dueDate: '2026-11-13T09:00', dueReminderLeadMinutes: 10081, repeatReminderMinutes: 7 },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: '只有 due、无 review',
    task: { id: 't-duenorev', status: 'next', dueDate: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
  {
    name: '只有 start、无提前量',
    task: { id: 't-startonly', status: 'next', startTime: '2026-11-13T09:00' },
    notify: { includeStart: true, includeDue: true, includeReview: true, globalDefault: SEND },
    official: { includeStartTime: true, includeDueDate: true, includeReviewAt: true, taskReminderDefault: SEND },
  },
];

// ---------------------------------------------------------------------------
// 逐条比对：官方 getTaskReminderPlan 与 Notify 的 (task_id, kind, scheduledAt) 必须完全一致
// ---------------------------------------------------------------------------

test('黄金数据集：官方与 Notify 逐条比对差集为空', () => {
  for (const c of cases) {
    const notify = notifyTuples(c.task, c.notify);
    const official = officialGetTaskReminderPlanTuples(c.task, c.official);
    const diff = diffTuples(notify, official);
    assert.deepEqual(
      diff.onlyNotify,
      [],
      `${c.name}\n  Notify 多出：${diff.onlyNotify.join(', ') || '（无）'}`,
    );
    assert.deepEqual(
      diff.onlyOfficial,
      [],
      `${c.name}\n  官方多出：${diff.onlyOfficial.join(', ') || '（无）'}`,
    );
  }
});

test('黄金数据集：全量合并后差集仍为空（strict 一致性）', () => {
  const allNotify: TriggerTuple[] = [];
  const allOfficial: TriggerTuple[] = [];
  for (const c of cases) {
    allNotify.push(...notifyTuples(c.task, c.notify));
    allOfficial.push(...officialGetTaskReminderPlanTuples(c.task, c.official));
  }
  const diff = diffTuples(allNotify, allOfficial);
  assert.deepEqual(diff.onlyNotify, [], `Notify 多出：${diff.onlyNotify.join(', ')}`);
  assert.deepEqual(diff.onlyOfficial, [], `官方多出：${diff.onlyOfficial.join(', ')}`);
});
