/**
 * M3 测试：标签路由、三个平台适配器。
 *
 * 所有网络请求都用注入的假 fetch，本文件不会触达任何真实服务。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';
import {
  buildPlatformRequest, deliverPlatformWebhook, dingtalkSign, feishuSign, renderPlatformText,
} from '../src/dispatch/adapters.ts';
import type { NotifyMessage } from '../src/dispatch/message.ts';
import { buildPlan } from '../src/rules/plan.ts';
import { filterChannelsByTags, getTagPolicy, parseTaskTags } from '../src/rules/tag-policy.ts';
import type { MindwtrTask } from '../src/types.ts';

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    root: '/nonexistent-notify-root',
    env: { MINDWTR_TOKEN: 'test-token', MINDWTR_BASE_URL: 'https://example.invalid', ...overrides },
  });
}

function makeTask(fields: Partial<MindwtrTask> = {}): MindwtrTask {
  return { id: 'task-1', status: 'next', ...fields };
}

/** 固定的非摘要时刻（北京时间 11:00），避免摘要触发点干扰断言。 */
const NOW = Date.parse('2026-11-13T03:00:00Z');
const CHANNELS = ['email', 'webhook:0'];

const sampleMessage: NotifyMessage = {
  event: 'task.due',
  task: { id: 'task-1', title: '写周报', status: 'next', dueDate: '2026-11-13T09:00:00Z' },
  sentAt: new Date(NOW).toISOString(),
};

// ---------------------------------------------------------------------------
// 标签路由（EXT-19）
// ---------------------------------------------------------------------------

test('标签解析：正文里的 #tag / @context 与 tags/contexts 数组都能识别', () => {
  const tags = parseTaskTags(makeTask({
    title: '写周报 #notify-email',
    description: '属于 @work 上下文',
    tags: ['silent', { name: '#notify-webhook' }],
    contexts: [{ title: 'home' }],
  }));
  assert.ok(tags.includes('notify-email'));
  assert.ok(tags.includes('work'));
  assert.ok(tags.includes('silent'));
  assert.ok(tags.includes('notify-webhook'));
  assert.ok(tags.includes('home'));
});

test('标签规则默认关闭，渠道列表原样放行', () => {
  const config = testConfig();
  assert.equal(config.m3.tagRules.enabled, false);
  assert.deepEqual(filterChannelsByTags(makeTask({ title: '#silent' }), CHANNELS, config), CHANNELS);
});

test('开启后：silent 全静默、notify-email 只发邮件、notify-webhook 只发 Webhook', () => {
  const config = testConfig();
  config.m3.tagRules.enabled = true;

  assert.deepEqual(filterChannelsByTags(makeTask({ title: '#silent' }), CHANNELS, config), []);
  assert.equal(getTagPolicy(makeTask({ title: '@silent' }), config).silent, true);
  assert.deepEqual(filterChannelsByTags(makeTask({ title: '#notify-email' }), CHANNELS, config), ['email']);
  assert.deepEqual(filterChannelsByTags(makeTask({ title: '#notify-webhook' }), CHANNELS, config), ['webhook:0']);
  assert.deepEqual(filterChannelsByTags(makeTask({ title: '普通任务' }), CHANNELS, config), CHANNELS);
  // 摘要类没有对应任务，不受标签影响。
  assert.deepEqual(filterChannelsByTags(undefined, CHANNELS, config), CHANNELS);
});

test('标签规则不改写任何 BASE 触发点（spec §13 验收）', () => {
  const off = testConfig();
  const on = testConfig();
  on.m3.tagRules.enabled = true;

  const tasks = [makeTask({ title: '写周报 #silent', dueDate: '2026-11-13T09:00:00Z' })];
  const base = { tasks, projects: new Map(), now: NOW, strict: true, store: { getMeta: () => null } };
  const planOff = buildPlan({ ...base, config: off });
  const planOn = buildPlan({ ...base, config: on });

  assert.deepEqual(planOn.map(item => item.kind), planOff.map(item => item.kind));
  assert.deepEqual(planOn.map(item => item.scheduledAt), planOff.map(item => item.scheduledAt));
  assert.ok(planOn.length > 0, '标签只影响投递渠道，触发点仍在');
});

// ---------------------------------------------------------------------------
// 平台适配器（EXT-19）
// ---------------------------------------------------------------------------

test('钉钉签名用固定向量，且 sign/timestamp 追加到 URL', () => {
  // 固定向量由独立计算得到，用于锁死「key=secret、data=timestamp\nsecret」这个易错顺序。
  assert.equal(dingtalkSign('secret', 1_700_000_000_000), 'OuzzJR5+xZ4/EYwqtNt6sMYZQMTa/HEGvc9miJe7XzY=');

  const request = buildPlatformRequest('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    'secret', sampleMessage, 1_700_000_000_000);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('timestamp'), '1700000000000');
  assert.equal(url.searchParams.get('sign'), 'OuzzJR5+xZ4/EYwqtNt6sMYZQMTa/HEGvc9miJe7XzY=');
  const body = JSON.parse(request.body);
  assert.equal(body.msgtype, 'markdown');
  assert.match(body.markdown.text, /写周报/);
});

test('飞书签名用固定向量，且 timestamp/sign 放在 JSON body', () => {
  assert.equal(feishuSign('secret', 1_700_000_000), 'fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=');

  const request = buildPlatformRequest('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
    'secret', sampleMessage, 1_700_000_000_000);
  const body = JSON.parse(request.body);
  assert.equal(body.msg_type, 'text');
  assert.equal(body.timestamp, '1700000000');
  assert.equal(body.sign, 'fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=');
  assert.match(body.content.text, /写周报/);
});

test('企业微信使用 text 格式，无需签名', () => {
  const request = buildPlatformRequest('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
    '', sampleMessage, NOW);
  assert.equal(request.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc');
  const body = JSON.parse(request.body);
  assert.equal(body.msgtype, 'text');
  assert.match(body.text.content, /写周报/);
  assert.equal('sign' in body, false);
});

test('平台消息渲染：系统告警的 note 会显示出来', () => {
  const text = renderPlatformText({
    event: 'system', note: 'Cloud API 连续失败 3 次',
    sentAt: new Date(NOW).toISOString(),
  });
  assert.match(text, /Cloud API 连续失败 3 次/);
  assert.match(text, /系统通知/);
  assert.equal(text.includes('打开：'), false, '不再输出打不开的链接');
});

test('适配器投递复用 POST 重试，失败两次后第三次成功', async () => {
  let calls = 0;
  const seen: string[] = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    calls += 1;
    seen.push(String(input) + '|' + init?.method);
    return new Response(calls < 3 ? 'fail' : 'ok', { status: calls < 3 ? 500 : 200 });
  }) as unknown as typeof fetch;

  const result = await deliverPlatformWebhook('wecom', 'https://example.invalid/hook', '', sampleMessage, {
    fetchImpl: fakeFetch, maxAttempts: 3, sleep: async () => {}, now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.ok(seen.every(item => item.endsWith('|POST')), '平台通道只发 POST 到外部机器人');
});
