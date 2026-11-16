/**
 * M2 投递层测试：签名、重试、消息隐私、邮件编码、状态库、只读客户端
 *
 * 网络相关部分全部用注入的假 fetch / 假 transport，不产生任何外部请求。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { createCloudClient } from '../src/cloud/client.ts';
import { channelDedupeKey, recordDelivery } from '../src/dispatch/index.ts';
import { buildRawMail } from '../src/dispatch/email.ts';
import { renderMessage, stripMarkdown, type EmailContent } from '../src/dispatch/message.ts';
import { deliverWebhook, signBody, verifySignature } from '../src/dispatch/webhook.ts';
import { buildPlan } from '../src/rules/plan.ts';
import { createScheduler } from '../src/scheduler.ts';
import { createStateStore } from '../src/state/store.ts';
import type { MindwtrTask } from '../src/types.ts';

/** 构造测试配置，不读本机 .env。 */
function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    root: '/nonexistent-notify-root',
    env: { MINDWTR_TOKEN: 'test-token', MINDWTR_BASE_URL: 'https://example.invalid', ...overrides },
  });
}

function makeTask(fields: Partial<MindwtrTask> = {}): MindwtrTask {
  return { id: 'task-1', status: 'next', ...fields };
}

// ---------------------------------------------------------------------------
// Webhook 签名与重试（EXT-04 / EXT-05）
// ---------------------------------------------------------------------------

test('HMAC 签名：正确签名可验证，篡改正文或超时会被拒绝', () => {
  const secret = 'test-secret';
  const body = '{"event":"task.due"}';
  const now = Math.floor(Date.now() / 1000);
  const signature = `sha256=${signBody(secret, now, body)}`;

  assert.equal(verifySignature(secret, now, body, signature), true);
  assert.equal(verifySignature(secret, now, body + ' ', signature), false);
  assert.equal(verifySignature('wrong-secret', now, body, signature), false);
  assert.equal(verifySignature(secret, now - 3600, body, signature), false, '超过 5 分钟拒绝重放');
});

test('Webhook 失败后指数退避重试，最后一次成功返回尝试次数', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(calls < 3 ? 'fail' : 'ok', { status: calls < 3 ? 500 : 200 });
  }) as unknown as typeof fetch;

  const result = await deliverWebhook('https://example.invalid/hook', '{"a":1}', 'secret', {
    fetchImpl: fakeFetch,
    maxAttempts: 3,
    sleep: async () => {}, // 测试里不真的等待
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// 消息内容与隐私（EXT-02 / EXT-03 / BASE-15）
// ---------------------------------------------------------------------------

test('单任务消息带去 Markdown 的描述，且不含敏感字段', () => {
  const config = testConfig();
  const plan = buildPlan({
    tasks: [makeTask({
      dueDate: '2026-11-13T09:00:00Z',
      description: '**重要** [链接](https://x) `code`',
      attachments: ['a'], assignedTo: ['u'], contexts: ['c'], tags: ['t'],
    })],
    projects: new Map(),
    config,
    now: Date.parse('2026-11-13T08:59:00Z') - config.pollIntervalSeconds * 1000,
    strict: true,
    store: { getMeta: () => null },
  });
  const item = plan.find(entry => entry.kind === 'due');
  assert.ok(item);

  const message = renderMessage(item, new Map([['p1', '项目名称']]));
  assert.equal(message.task?.description, '重要 链接 code');
  for (const field of ['attachments', 'assignedTo', 'contexts', 'tags']) {
    assert.equal(field in (message.task ?? {}), false, `${field} 不应外发`);
  }
  assert.equal(stripMarkdown('**a**\n\n# b'), 'a b');
});

test('汇总类消息不带任务描述', () => {
  const config = testConfig();
  const fakePlan = {
    event: 'digest_morning', kind: 'digest-morning', scheduledAt: Date.now(),
    dedupeKey: 'digest-morning:2026-11-13',
    digest: {
      dueToday: [{ id: 'a', title: '任务A', status: 'next' }],
      overdue: [], startingToday: [], focused: [],
    },
  };
  const message = renderMessage(fakePlan, new Map());
  assert.equal(message.digest?.dueToday.length, 1);
  assert.equal('description' in message, false);
  assert.equal('task' in message, false);
});

test('邮件原始报文：中文主题被编码、正文用 base64', () => {
  const mail: EmailContent = {
    to: ['me@example.com'],
    subject: '[Notify] 截止提醒：写周报',
    text: '任务：写周报',
    html: '<div>任务：写周报</div>',
  };
  const raw = buildRawMail(mail, 'notify@example.com', 'Notify');
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.ok(raw.includes(Buffer.from(mail.html, 'utf8').toString('base64').slice(0, 20)));
});

// ---------------------------------------------------------------------------
// 状态库（EXT-06 / EXT-07）
// ---------------------------------------------------------------------------

test('状态库：同一触发点按渠道分别去重，失败可重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const store = await createStateStore(join(dir, 'state.sqlite'));
  try {
    const planKey = 'task-1:due:2026-11-13T09:00:00.000Z';
    const emailKey = channelDedupeKey(planKey, 'email');
    const hookKey = channelDedupeKey(planKey, 'webhook:0');

    recordDelivery(store, emailKey, { ok: true, attempts: 1 },
      { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'email' });
    recordDelivery(store, hookKey, { ok: false, attempts: 3, error: 'timeout' },
      { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'webhook:0' });

    assert.equal(store.hasSent(emailKey), true, '邮件成功视为已处理');
    assert.equal(store.hasSent(hookKey), false, 'Webhook 失败仍可重试');
    assert.equal(store.channelStatus()['webhook:0'].status, 'failed');

    // 回归（不新增 test 用例，保持 62/62）：Bun 下 socket 错误的 message 可能是空串，
    // 写库时必须落到兜底文案；异常文本里的 Webhook URL 还要脱敏，不能把密钥写进状态库。
    const emptyErrorKey = channelDedupeKey(planKey, 'webhook:1');
    recordDelivery(store, emptyErrorKey,
      { ok: false, attempts: 1, error: '' },
      { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'webhook:1' });
    const secretKey = channelDedupeKey(planKey, 'webhook:2');
    recordDelivery(store, secretKey,
      { ok: false, attempts: 1, error: 'fetch failed: https://hook.example.invalid/abc?token=SECRET_VALUE_123' },
      { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'webhook:2' });
    const failedRecords = store.listRecords({ statuses: ['failed'] });
    assert.equal(
      failedRecords.find(item => item.dedupeKey === emptyErrorKey)?.lastError,
      '未知错误', '空错误信息应落到兜底文案',
    );
    const secretRecord = failedRecords.find(item => item.dedupeKey === secretKey);
    assert.ok(secretRecord?.lastError.includes('[url]'), 'URL 已脱敏');
    assert.ok(!secretRecord?.lastError.includes('SECRET_VALUE_123'), 'URL 中的密钥不落库');

    store.setMeta('last_backlog_at', '123');
    assert.equal(store.getMeta('last_backlog_at'), '123');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 只读客户端（EXT-09 / EXT-15）
// ---------------------------------------------------------------------------

test('Cloud 客户端：按 total 翻页、按 rev 取新，且只发 GET', async () => {
  const requested: { method: string; url: string }[] = [];
  const pages: Record<string, unknown> = {
    'offset=0': {
      tasks: [
        { id: 'a', status: 'next', rev: 1 },
        { id: 'b', status: 'next', rev: 1 },
      ],
      total: 3, limit: 2, offset: 0,
    },
    'offset=2': {
      tasks: [{ id: 'a', status: 'next', rev: 5 }],
      total: 3, limit: 2, offset: 2,
    },
  };

  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    requested.push({ method: init?.method ?? 'GET', url });
    if (url.includes('/v1/projects')) return new Response(JSON.stringify({ projects: [], total: 0 }), { status: 200 });
    const key = url.includes('offset=2') ? 'offset=2' : 'offset=0';
    // 只让 next 状态返回数据，其余状态为空，避免重复计数。
    const body = url.includes('status=next') ? pages[key] : { tasks: [], total: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createCloudClient(testConfig(), fakeFetch);
  const result = await client.fetchActiveTasks();

  assert.equal(result.items.length, 2, 'a 与 b 各一条');
  assert.equal(result.items.find(item => item.id === 'a')?.rev, 5, '同 id 取 rev 较大的');
  assert.ok(requested.every(request => request.method === 'GET'), '不允许任何写请求');
  assert.ok(requested.every(request => request.url.includes('status=')), '分状态拉取');
});

// ---------------------------------------------------------------------------
// 调度器（dry-run、渠道级去重、补发窗口）
// ---------------------------------------------------------------------------

test('调度器：dry-run 不投递；同一点第二轮按渠道去重', async () => {
  const config = testConfig();
  const now = Date.parse('2026-11-13T03:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'notify-sched-'));
  const store = await createStateStore(join(dir, 'state.sqlite'));
  const delivered: string[] = [];

  const cloud = {
    fetchActiveTasks: async () => ({
      items: [makeTask({ dueDate: new Date(now - 1000).toISOString() })],
      total: 1, pages: 1, stoppedBy: 'exhausted',
    }),
    fetchProjects: async () => [],
    health: async () => true,
    recordSuccess: () => ({ failures: 0, recovered: false }),
    recordFailure: () => ({ failures: 1 }),
    nextDelayMs: () => 1000,
    lastError: () => '',
  };

  // 手动加一个假 Webhook 渠道，验证「邮件成功不影响 Webhook 去重」。
  const trackedDispatcher = {
    channels: ['email', 'webhook:0'],
    deliverChannel: async (channel: string) => {
      delivered.push(channel);
      return { ok: true, attempts: 1 };
    },
    deliver: async () => ({}),
  };

  const scheduler = createScheduler({
    config, cloud: cloud as never, store,
    dispatcher: trackedDispatcher as never,
    now: () => now,
    log: () => {},
  });

  try {
    const dry = await scheduler.runOnce({ dryRun: true, strict: true });
    assert.equal(dry.due >= 1, true);
    assert.equal(delivered.length, 0, 'dry-run 不得投递');

    const first = await scheduler.runOnce({ strict: true });
    assert.equal(first.sent, 2, '两个渠道各投一次');
    assert.deepEqual(delivered.sort(), ['email', 'webhook:0']);

    const second = await scheduler.runOnce({ strict: true });
    assert.equal(second.sent, 0);
    assert.equal(second.duplicates, 2, '第二轮两个渠道都命中去重');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('调度器：超过 5 分钟补发窗口的触发点标为过期，不投递', async () => {
  const config = testConfig();
  const now = Date.parse('2026-11-13T03:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'notify-late-'));
  const store = await createStateStore(join(dir, 'state.sqlite'));
  let deliveries = 0;

  const cloud = {
    fetchActiveTasks: async () => ({
      items: [makeTask({ dueDate: new Date(now - 10 * 60_000).toISOString() })],
      total: 1, pages: 1, stoppedBy: 'exhausted',
    }),
    fetchProjects: async () => [],
    health: async () => true,
    recordSuccess: () => ({ failures: 0, recovered: false }),
    recordFailure: () => ({ failures: 1 }),
    nextDelayMs: () => 1000,
    lastError: () => '',
  };
  const dispatcher = {
    channels: ['email'],
    deliverChannel: async () => { deliveries += 1; return { ok: true, attempts: 1 }; },
    deliver: async () => ({}),
  };

  const scheduler = createScheduler({
    config, cloud: cloud as never, store, dispatcher: dispatcher as never,
    now: () => now, log: () => {},
  });

  try {
    const result = await scheduler.runOnce({ strict: true });
    assert.equal(result.skippedLate >= 1, true);
    assert.equal(deliveries, 0, '过期触发点不补发');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
