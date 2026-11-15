/**
 * Webhook 业务响应校验回归测试（v1.15）
 *
 * 全部用注入的假 fetch，不产生任何外部请求。
 * 重点覆盖「HTTP 200 但 errcode!=0」的假成功，同时守住一条底线：
 * 不能误伤空 body、纯文本、自定义接收端的普通 JSON 等本来就算成功的情况。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverPlatformWebhook } from '../src/dispatch/adapters.ts';
import type { NotifyMessage } from '../src/dispatch/message.ts';
import { deliverWebhook, parseWebhookBusinessError, postWebhook } from '../src/dispatch/webhook.ts';

const HOOK_URL = 'https://hooks.example.invalid/robot';
const RAW_BODY = '{"event":"test"}';
const NOW = Date.parse('2026-11-15T14:00:00Z');

const sampleMessage: NotifyMessage = {
  event: 'test',
  links: { app: 'https://cloud.example.invalid' },
  sentAt: new Date(NOW).toISOString(),
};

/** 构造固定响应的假 fetch，并记录调用次数与发出的请求体。 */
function fakeFetchWith(responses: Array<{ status?: number; body?: string }>) {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    calls += 1;
    bodies.push(String(init?.body ?? ''));
    const item = responses[Math.min(calls - 1, responses.length - 1)];
    return new Response(item.body ?? '', { status: item.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, getCalls: () => calls, bodies };
}

// ---------------------------------------------------------------------------
// 纯函数：只认明确的机器人业务码形状
// ---------------------------------------------------------------------------

test('业务码解析：企微 / 钉钉的 errcode=0 是成功，不产生业务错误', () => {
  assert.equal(parseWebhookBusinessError('{"errcode":0,"errmsg":"ok"}'), null);
  assert.equal(parseWebhookBusinessError('{"errcode":0}'), null);
});

test('业务码解析：errcode 非 0 返回错误码与脱敏短文本', () => {
  const result = parseWebhookBusinessError(JSON.stringify({
    errcode: 40058,
    errmsg: 'invalid webhook url, hint: https://hooks.example.invalid/x?key=SECRET_VALUE_123',
  }));
  assert.equal(result?.code, 40058);
  assert.match(result?.message ?? '', /invalid webhook url/);
  assert.match(result?.message ?? '', /\[url\]/, 'URL 已替换');
  assert.ok(!(result?.message ?? '').includes('SECRET_VALUE_123'), '密钥不进入错误文本');
});

test('业务码解析：空 body / 非 JSON / 普通 JSON 都不干预 HTTP 语义', () => {
  const samples = [
    '', '   ', 'ok', '<html>502</html>', '{"ok":true}',
    '{"code":200}', '{"errcode":"0"}', '[]', 'null',
  ];
  for (const text of samples) {
    assert.equal(parseWebhookBusinessError(text), null, `不应误判：${text}`);
  }
});

test('业务码解析：飞书 StatusCode / code 必须同时带消息字段才认', () => {
  assert.equal(parseWebhookBusinessError('{"StatusCode":0,"StatusMessage":"success"}'), null);
  assert.equal(parseWebhookBusinessError('{"code":0,"msg":"success"}'), null);
  assert.equal(parseWebhookBusinessError('{"code":500}'), null, '缺消息字段不能误伤 generic 接收端');

  const current = parseWebhookBusinessError('{"StatusCode":19001,"StatusMessage":"bad sign"}');
  assert.equal(current?.code, 19001);
  assert.match(current?.message ?? '', /bad sign/);
  const legacy = parseWebhookBusinessError('{"code":19021,"msg":"sign match fail"}');
  assert.equal(legacy?.code, 19021);
});

// ---------------------------------------------------------------------------
// 投递层：2xx 判定之后再加一层业务码判定
// ---------------------------------------------------------------------------

test('HTTP 200 + errcode!=0 判定失败，且不即时重试', async () => {
  const fake = fakeFetchWith([{ status: 200, body: '{"errcode":40058,"errmsg":"invalid webhook url"}' }]);
  const result = await postWebhook(HOOK_URL, RAW_BODY, {}, {
    fetchImpl: fake.fetchImpl, maxAttempts: 3, sleep: async () => {},
  });
  assert.equal(result.ok, false, '不能把业务失败当成成功');
  assert.equal(result.attempts, 1);
  assert.equal(fake.getCalls(), 1, '业务失败是确定性错误，重发同一个 body 只会刷群');
  assert.match(result.error ?? '', /errcode=40058/);
  assert.match(result.error ?? '', /invalid webhook url/);
});

test('HTTP 200 + errcode=0 仍然成功', async () => {
  const fake = fakeFetchWith([{ status: 200, body: '{"errcode":0,"errmsg":"ok"}' }]);
  const result = await deliverWebhook(HOOK_URL, RAW_BODY, 'secret', {
    fetchImpl: fake.fetchImpl, maxAttempts: 3, sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
});

test('空 body / 纯文本 / 自定义 JSON 保持原来的 2xx 成功语义', async () => {
  for (const body of ['', 'ok', '{"ok":true}', '{"received":1}']) {
    const fake = fakeFetchWith([{ status: 200, body }]);
    const result = await deliverWebhook(HOOK_URL, RAW_BODY, 'secret', {
      fetchImpl: fake.fetchImpl, maxAttempts: 3, sleep: async () => {},
    });
    assert.equal(result.ok, true, `响应体 ${JSON.stringify(body)} 应视为成功`);
  }
});

test('HTTP 非 2xx 仍按原逻辑退避重试三次（回归保护）', async () => {
  const fake = fakeFetchWith([{ status: 500, body: 'fail' }]);
  const result = await deliverWebhook(HOOK_URL, RAW_BODY, 'secret', {
    fetchImpl: fake.fetchImpl, maxAttempts: 3, sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(fake.getCalls(), 3);
  assert.match(result.error ?? '', /HTTP 500/);
});

test('非 2xx 响应里带业务码时，错误文本同时含 HTTP 状态与 errcode', async () => {
  const fake = fakeFetchWith([{ status: 400, body: '{"errcode":40058,"errmsg":"invalid key"}' }]);
  const result = await postWebhook(HOOK_URL, RAW_BODY, {}, {
    fetchImpl: fake.fetchImpl, maxAttempts: 1, sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /HTTP 400/);
  assert.match(result.error ?? '', /errcode=40058/);
});

test('wecom 适配器链路同样捕获业务失败，发出的 body 仍是 text 格式', async () => {
  const fake = fakeFetchWith([{ status: 200, body: '{"errcode":40008,"errmsg":"invalid msgtype"}' }]);
  const result = await deliverPlatformWebhook('wecom', HOOK_URL, '', sampleMessage, {
    fetchImpl: fake.fetchImpl, maxAttempts: 3, sleep: async () => {}, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /errcode=40008/);
  const sent = JSON.parse(fake.bodies[0]);
  assert.equal(sent.msgtype, 'text', 'wecom 走的是平台适配器而不是 generic 结构化消息');
  assert.match(sent.text.content, /渠道测试/);
});

test('业务错误文本里的 URL 与密钥不会写进 result.error', async () => {
  const fake = fakeFetchWith([{
    status: 200,
    body: JSON.stringify({
      errcode: 45009,
      errmsg: 'api freq out of limit, hint: https://qyapi.weixin.qq.com/x?key=SECRET_VALUE_123',
    }),
  }]);
  const result = await postWebhook(HOOK_URL, RAW_BODY, {}, {
    fetchImpl: fake.fetchImpl, maxAttempts: 1, sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(!(result.error ?? '').includes('SECRET_VALUE_123'), '密钥不落库、不进日志');
  assert.match(result.error ?? '', /\[url\]/);
});
