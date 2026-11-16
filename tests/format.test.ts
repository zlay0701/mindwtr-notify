/**
 * 显示时间格式（EXT-21【官方无】）测试
 *
 * 覆盖三件事：时区换算 + 自定义 pattern、仅日期不被补时间、结构化 JSON 不受影响。
 * 全部是纯函数，不联网、不发消息。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';
import { formatStamp } from '../src/format.ts';
import { renderMessage, renderEmail, reminderHeading } from '../src/dispatch/message.ts';
import { renderPlatformText } from '../src/dispatch/adapters.ts';
import { DEFAULT_TIME_FORMAT, formatDateTime } from '../src/rules/time.ts';

const UTC_TIME = '2026-11-16T15:00:00.000Z'; // 北京时间 23:00:00

function testConfig(format?: string) {
  const env: Record<string, string> = {
    MINDWTR_TOKEN: 'test-token',
    MINDWTR_BASE_URL: 'https://cloud.example.invalid',
    NOTIFY_TIMEZONE: 'Asia/Shanghai',
  };
  if (format !== undefined) env.NOTIFY_TIME_FORMAT = format;
  return loadConfig({ root: '/nonexistent-notify-root', env });
}

function makePlan() {
  return {
    event: 'task.due', kind: 'due', taskId: 't1',
    task: {
      id: 't1', title: '示例任务', status: 'next',
      dueDate: UTC_TIME, startTime: '2026-11-16T13:00:00.000Z',
    },
    trigger: { type: 'due', at: UTC_TIME },
    scheduledAt: Date.parse(UTC_TIME), dedupeKey: 'demo',
  };
}

test('formatDateTime 按业务时区渲染，支持自定义 token 组合', () => {
  const epoch = Date.parse(UTC_TIME);
  assert.equal(formatDateTime(epoch, 'Asia/Shanghai', DEFAULT_TIME_FORMAT), '2026-11-16 23:00:00');
  assert.equal(formatDateTime(epoch, 'Asia/Shanghai', 'yyyy/MM/dd HH:mm'), '2026/11/16 23:00');
  assert.equal(formatDateTime(epoch, 'UTC', DEFAULT_TIME_FORMAT), '2026-11-16 15:00:00');
  // 只有日期的 pattern 也能用
  assert.equal(formatDateTime(epoch, 'Asia/Shanghai', 'yyyy-MM-dd'), '2026-11-16');
});

test('formatStamp：仅日期保持原样，非法值原样，空值返回空串', () => {
  const options = { pattern: DEFAULT_TIME_FORMAT, timeZone: 'Asia/Shanghai' };
  assert.equal(formatStamp(UTC_TIME, options), '2026-11-16 23:00:00');
  assert.equal(formatStamp('2026-11-16', options), '2026-11-16', '仅日期不补 00:00:00');
  assert.equal(formatStamp('不是时间', options), '不是时间', '解析不了就原样输出');
  assert.equal(formatStamp(undefined, options), '');
  assert.equal(formatStamp('', options), '');
});

test('NOTIFY_TIME_FORMAT：默认值、可配置、无有效 token 时回退', () => {
  assert.equal(testConfig().timeFormat, DEFAULT_TIME_FORMAT);
  assert.equal(testConfig('yyyy/MM/dd HH:mm').timeFormat, 'yyyy/MM/dd HH:mm');
  assert.equal(testConfig('MM-dd HH:mm:ss').timeFormat, 'MM-dd HH:mm:ss');
  // 一个 token 都没有 → 回退默认，避免消息里出现无意义的字面量
  assert.equal(testConfig('date').timeFormat, DEFAULT_TIME_FORMAT);
});

test('文本渠道用配置的格式，结构化 JSON 仍是 ISO 8601', () => {
  const plan = makePlan();
  const message = renderMessage(plan, new Map());
  const config = testConfig();

  // 结构化消息不变：接收端要能机器解析
  assert.equal(message.task?.dueDate, UTC_TIME);

  const email = renderEmail(plan, message, config);
  assert.match(email.text, /【任务提醒 · 截止时间】/);
  assert.match(email.text, /截止时间：2026-11-16 23:00:00/);
  assert.equal(email.text.includes('开始时间：'), false, '只展示触发的那一种时间，不打其它时间字段');
  assert.equal(email.text.includes('Z'), false, '邮件正文不应再出现 ISO 的 Z 后缀');

  const text = renderPlatformText(message, { pattern: config.timeFormat, timeZone: config.timezone });
  assert.match(text, /【任务提醒 · 截止时间】/);
  assert.match(text, /截止时间：2026-11-16 23:00:00/);
  assert.equal(text.includes(UTC_TIME), false);

  // 换成自定义格式后，文本跟着变
  const custom = testConfig('yyyy/MM/dd HH:mm');
  const customEmail = renderEmail(plan, message, custom);
  assert.match(customEmail.text, /截止时间：2026\/11\/16 23:00/);
});

test('抬头明确区分来源（任务/项目/其他）与时间类别（开始/截止/回顾）', () => {
  // 任务级：三种时间都带「任务提醒」前缀。
  assert.equal(reminderHeading('task.due'), '任务提醒 · 截止时间');
  assert.equal(reminderHeading('task.due_advance'), '任务提醒 · 截止时间');
  assert.equal(reminderHeading('task.start'), '任务提醒 · 开始时间');
  assert.equal(reminderHeading('task.start_advance'), '任务提醒 · 开始时间');
  assert.equal(reminderHeading('task.review'), '任务提醒 · 回顾时间');
  // 项目级：来源换成「项目提醒」，时间是回顾。
  assert.equal(reminderHeading('task.project_review'), '项目提醒 · 回顾时间');
  // 其他：摘要/系统/测试归为「其他提醒」，并保留具体类别。
  assert.equal(reminderHeading('digest_morning'), '其他提醒 · 晨间简报');
  assert.equal(reminderHeading('backlog'), '其他提醒 · 积压逾期');
  assert.equal(reminderHeading('system'), '其他提醒 · 系统通知');
});

test('任务同时有多种时间字段时，只展示触发的那一种；项目提醒打回顾时间', () => {
  const config = testConfig();
  const baseTask = {
    id: 't1', title: '示例任务', status: 'next',
    dueDate: UTC_TIME, startTime: '2026-11-16T13:00:00.000Z', reviewAt: '2026-11-16T14:00:00.000Z',
  };

  for (const [kind, event, want, notWant] of [
    ['due', 'task.due', '截止时间', '开始时间'],
    ['start', 'task.start', '开始时间', '截止时间'],
    ['review', 'task.review', '回顾时间', '截止时间'],
  ]) {
    const plan = {
      event, kind, taskId: 't1', task: baseTask,
      trigger: { type: kind, at: UTC_TIME },
      scheduledAt: Date.parse(UTC_TIME), dedupeKey: 'demo',
    };
    const message = renderMessage(plan, new Map());
    const text = renderPlatformText(message, { pattern: config.timeFormat, timeZone: config.timezone });
    assert.match(text, new RegExp(`【任务提醒 · ${want}】`), `平台文本抬头应标明 ${want}`);
    assert.match(text, new RegExp(`${want}：`), `应展示 ${want}`);
    assert.equal(text.includes(`${notWant}：`), false, `不应展示非触发的 ${notWant}`);
    assert.match(renderEmail(plan, message, config).text, new RegExp(want));
  }

  // 项目回顾：抬头写「项目提醒 · 回顾时间」，正文带项目名与回顾时间。
  const projectPlan = {
    event: 'task.project_review', kind: 'project-review', taskId: undefined,
    project: { id: 'p1', title: '示例项目' },
    trigger: { type: 'project-review', at: UTC_TIME },
    scheduledAt: Date.parse(UTC_TIME), dedupeKey: 'demo',
  };
  const projectMessage = renderMessage(projectPlan, new Map());
  const projectText = renderPlatformText(projectMessage, { pattern: config.timeFormat, timeZone: config.timezone });
  assert.match(projectText, /【项目提醒 · 回顾时间】/);
  assert.match(projectText, /项目：示例项目/);
  assert.match(projectText, /回顾时间：2026-11-16 23:00:00/);
});
