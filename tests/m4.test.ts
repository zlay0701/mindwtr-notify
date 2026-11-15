/**
 * M4 测试：多命名空间隔离、只读管理页、受鉴权重发、审计日志与 strict 一致性
 *
 * 全部使用临时 SQLite 文件与本机回环 HTTP（port=0 由系统分配），
 * 不触达任何真实 Cloud API，也不产生任何外部网络请求。
 * 对应 spec §14 验收：页面不泄露 token；命名空间之间不串数据；
 * 手动重发受 HEALTHZ_TOKEN / 独立鉴权保护。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAdminHandler } from '../src/admin.ts';
import { loadConfig, type NotifyConfig } from '../src/config.ts';
import { channelDedupeKey, recordDelivery } from '../src/dispatch/index.ts';
import { startHealthz } from '../src/healthz.ts';
import { buildPlan } from '../src/rules/plan.ts';
import { createScheduler, type SchedulerStatus, type UpcomingItem } from '../src/scheduler.ts';
import {
  DEFAULT_NAMESPACE, namespacedKey, normalizeNamespace, statePathForNamespace, unscopeKey,
} from '../src/state/namespace.ts';
import { createStateStore, type StateStore } from '../src/state/store.ts';
import type { MindwtrTask } from '../src/types.ts';

/** 构造测试配置，不读本机 .env；可用 env 覆盖任意 M4 变量。 */
function testConfig(env: Record<string, string> = {}): NotifyConfig {
  return loadConfig({
    root: '/nonexistent-notify-root',
    env: { MINDWTR_TOKEN: 'test-token', MINDWTR_BASE_URL: 'https://example.invalid', ...env },
  });
}

function makeTask(fields: Partial<MindwtrTask> = {}): MindwtrTask {
  return { id: 'task-1', status: 'next', ...fields };
}

/** 固定的非摘要时刻（北京时间 11:00），避免摘要触发点干扰计划断言。 */
const NOW = Date.parse('2026-11-13T03:00:00Z');

/** 建一个临时目录，和 before/after 的清理交给各用例自己控制。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'notify-m4-'));
}

/** 起一个只监听回环的管理页服务，跑完自动关闭。 */
async function withAdminServer<T>(
  config: NotifyConfig,
  store: StateStore,
  run: (base: string) => Promise<T>,
  upcoming: () => UpcomingItem[] = () => [],
): Promise<T> {
  const getStatus = (): SchedulerStatus => ({
    ok: true,
    lastPollAt: NOW,
    lastErrorCount: 0,
    pendingCount: store.pendingCount(),
    channelStatus: store.channelStatus(),
    lastPlanCount: 3,
  });
  const admin = createAdminHandler({ config, store, getStatus, upcoming });
  const handle = startHealthz(0, getStatus, config.healthzToken, admin);
  await handle.ready;
  try {
    return await run(`http://127.0.0.1:${handle.port()}`);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// 一、命名空间工具（EXT-19【官方无】）
// ---------------------------------------------------------------------------

test('命名空间规范化：路径穿越 / 大小写 / 非法字符都被清洗', () => {
  assert.equal(normalizeNamespace(undefined), DEFAULT_NAMESPACE);
  assert.equal(normalizeNamespace('  '), DEFAULT_NAMESPACE);
  assert.equal(normalizeNamespace('Work'), 'work');
  assert.equal(normalizeNamespace('../../etc/passwd'), '______etc_passwd');
  assert.equal(normalizeNamespace('a/b:c'), 'a_b_c');
  assert.equal(normalizeNamespace('x'.repeat(50)).length, 32);
});

test('去重键与状态库路径按 namespace 分开，default 保持旧行为', () => {
  const raw = 'task-1:due:2026-11-13T09:00:00.000Z:email';
  assert.equal(namespacedKey('default', raw), raw, 'default 不加前缀，旧记录仍可命中');
  assert.equal(namespacedKey('work', raw), `ns=work:${raw}`);
  assert.notEqual(namespacedKey('work', raw), namespacedKey('home', raw));
  assert.equal(unscopeKey('work', namespacedKey('work', raw)), raw);
  assert.equal(unscopeKey('default', raw), raw);

  const base = resolve('data/notify.sqlite');
  assert.equal(statePathForNamespace(base, 'default'), base);
  assert.match(statePathForNamespace(base, 'work'), /notify-work\.sqlite$/);
  assert.notEqual(statePathForNamespace(base, 'work'), statePathForNamespace(base, 'home'));
});

// ---------------------------------------------------------------------------
// 二、配置按 namespace 分段
// ---------------------------------------------------------------------------

test('配置：默认命名空间 / 管理页默认值 / 重发默认关闭', () => {
  const config = testConfig();
  assert.equal(config.namespace, 'default');
  assert.equal(config.admin.enabled, true);
  assert.equal(config.admin.retryEnabled, false);
  assert.equal(config.admin.token, '');
  assert.match(config.statePath, /notify\.sqlite$/);
});

test('配置：namespaces JSON 段只覆盖当前命名空间，状态库路径自动派生', () => {
  const dir = tempDir();
  const configPath = join(dir, 'notify-config.json');
  writeFileSync(configPath, JSON.stringify({
    namespaces: {
      work: { NOTIFY_TIMEZONE: 'Asia/Tokyo', NOTIFY_ADMIN_PAGE: 'false', SMTP_ENABLED: 'true' },
      home: { NOTIFY_TIMEZONE: 'Europe/London' },
    },
  }));

  try {
    const work = loadConfig({
      root: dir,
      env: { NOTIFY_NAMESPACE: 'work', NOTIFY_CONFIG: configPath, MINDWTR_TOKEN: 't' },
    });
    assert.equal(work.namespace, 'work');
    assert.equal(work.timezone, 'Asia/Tokyo');
    assert.equal(work.admin.enabled, false);
    assert.equal(work.channels.email.enabled, true);
    assert.match(work.statePath, /notify-work\.sqlite$/);

    const home = loadConfig({
      root: dir,
      env: { NOTIFY_NAMESPACE: 'home', NOTIFY_CONFIG: configPath, MINDWTR_TOKEN: 't' },
    });
    assert.equal(home.timezone, 'Europe/London');
    assert.equal(home.channels.email.enabled, false, 'work 段的开关不能串到 home');
    assert.match(home.statePath, /notify-home\.sqlite$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 三、状态库隔离（三层：路径 / 表内列 / 键前缀）
// ---------------------------------------------------------------------------

test('状态库：同一文件内两个命名空间完全不串数据', async () => {
  const dir = tempDir();
  const path = join(dir, 'shared.sqlite');
  const work = await createStateStore(path, 'work');
  const home = await createStateStore(path, 'home');
  try {
    const raw = channelDedupeKey('task-1:due:2026-11-13T09:00:00.000Z', 'email');
    const meta = { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'email' };

    recordDelivery(work, raw, { ok: true, attempts: 1 }, meta);
    assert.equal(work.hasSent(raw), true);
    assert.equal(home.hasSent(raw), false, '同名去重键在另一个命名空间不应命中');

    work.setMeta('last_backlog_at', '123');
    assert.equal(home.getMeta('last_backlog_at'), null, 'meta 也按命名空间隔离');
    work.addAudit({ action: 'retry', actor: 'admin', detail: 'work-only', ok: true });
    assert.equal(home.listAudit().length, 0, '审计日志按命名空间隔离');

    assert.equal(home.listRecords({ statuses: ['sent'] }).length, 0);
    assert.deepEqual(home.channelStatus(), {});
    assert.equal(home.pendingCount(), 0);

    // 同一裸键在另一个命名空间写失败，不能影响第一个命名空间的结果。
    const hookMeta = { ...meta, channel: 'webhook:0' };
    recordDelivery(home, raw, { ok: false, attempts: 1, error: 'timeout' }, hookMeta);
    assert.equal(work.channelStatus().email.status, 'sent');
    assert.equal(home.channelStatus()['webhook:0'].status, 'failed');
    assert.equal(work.listRecords({ statuses: ['sent'] }).length, 1);
    assert.equal(home.listRecords({ statuses: ['sent'] }).length, 0);
    assert.equal(home.listRecords({ statuses: ['failed'] })[0].dedupeKey, raw,
      '管理页展示时前缀已被去掉');
  } finally {
    work.close(); home.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态库：不同文件各自独立；旧库升级补列后历史记录仍命中（不会重发）', async () => {
  const dir = tempDir();
  const legacyPath = join(dir, 'legacy.sqlite');
  const raw = 'task-1:due:2026-11-13T09:00:00.000Z:email';

  // 手工造一个 M1–M3 时代的旧表：没有 namespace 列，也没有 meta / audit_log 表。
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE sent_log (
      dedupe_key TEXT PRIMARY KEY, task_id TEXT, trigger_type TEXT NOT NULL,
      trigger_at INTEGER NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO sent_log
      (dedupe_key, task_id, trigger_type, trigger_at, channel, status, attempts, created_at, updated_at)
    VALUES ('${raw}', 'task-1', 'due', 1, 'email', 'sent', 1, 1, 1);
  `);
  legacy.close();

  const migrated = await createStateStore(legacyPath);
  const other = await createStateStore(join(dir, 'other.sqlite'), 'work');
  try {
    assert.equal(migrated.hasSent(raw), true, '旧库记录仍命中，升级 M4 不会重复投递');
    assert.equal(migrated.listRecords({ statuses: ['sent'] })[0].dedupeKey, raw);
    assert.equal(migrated.getMeta('anything'), null);
    assert.equal(other.hasSent(raw), false, '新命名空间使用独立文件，读不到旧库的记录');
    assert.equal(other.listRecords({ statuses: ['sent'] }).length, 0);
  } finally {
    migrated.close(); other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('手动重发：只把本地记录放回可重试状态，不存在的键返回 false', async () => {
  const dir = tempDir();
  const store = await createStateStore(join(dir, 'state.sqlite'), 'work');
  try {
    const raw = channelDedupeKey('task-1:due:2026-11-13T09:00:00.000Z', 'email');
    store.markPending(raw, { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'email' });
    store.markSent(raw);
    assert.equal(store.hasSent(raw), true);

    assert.equal(store.requestRetry(raw), true);
    assert.equal(store.hasSent(raw), false, '置为 failed 后下一轮可重试');
    assert.equal(store.listRecords({ statuses: ['failed'] })[0].dedupeKey, raw);
    assert.equal(store.requestRetry('not-exist'), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 四、只读管理页（spec §14 验收）
// ---------------------------------------------------------------------------

const SECRETS = {
  cloud: 'CLOUD-TOKEN-DO-NOT-LEAK-9876',
  admin: 'ADMIN-TOKEN-DO-NOT-LEAK-1234',
  healthz: 'HEALTHZ-TOKEN-DO-NOT-LEAK-5555',
  webhook: 'WEBHOOK-SECRET-DO-NOT-LEAK-2222',
  smtp: 'SMTP-PASS-DO-NOT-LEAK-3333',
};

test('管理页：四个只读视图数据正确，页面与所有 JSON 都不泄露凭据', async () => {
  const dir = tempDir();
  const config = testConfig({
    MINDWTR_TOKEN: SECRETS.cloud,
    NOTIFY_NAMESPACE: 'work',
    NOTIFY_ADMIN_TOKEN: SECRETS.admin,
    HEALTHZ_TOKEN: SECRETS.healthz,
    WEBHOOK_SECRET: SECRETS.webhook,
    SMTP_PASS: SECRETS.smtp,
  });
  const store = await createStateStore(join(dir, 'state.sqlite'), config.namespace);
  try {
    const sentKey = channelDedupeKey('task-1:due:2026-11-13T09:00:00.000Z', 'email');
    const failedKey = channelDedupeKey('task-2:due:2026-11-13T10:00:00.000Z', 'webhook:0');
    store.markPending(sentKey, { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'email' });
    store.markSent(sentKey);
    store.markPending(failedKey, { taskId: 'task-2', triggerType: 'due', triggerAt: 2, channel: 'webhook:0' });
    // 失败原因里故意带 URL 与长串标识，验证管理页会脱敏。
    store.markFailed(failedKey,
      'Webhook https://hook.example.invalid/secret?token=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 超时');

    const upcomingItem = {
      kind: 'due', taskId: 'task-u', event: 'task.due',
      scheduledAt: Date.parse('2026-11-14T01:00:00Z'),
    };
    await withAdminServer(config, store, async base => {
      const headers = { 'X-Admin-Token': SECRETS.admin };
      const page = await fetch(`${base}/admin`);
      const html = await page.text();
      assert.equal(page.status, 200);
      for (const title of ['已发记录', '失败 / 待重试', '渠道状态', '下一批待触发提醒', '审计日志']) {
        assert.ok(html.includes(title), `页面缺少「${title}」区块`);
      }

      // 未带 token 的 API 一律 401（页面骨架本身可直接打开，但不含数据）。
      const unauthorized = await fetch(`${base}/admin/api/overview`);
      assert.equal(unauthorized.status, 401);

      const responses: string[] = [html];
      const api = async (path: string) => {
        const response = await fetch(`${base}${path}`, { headers });
        const text = await response.text();
        responses.push(text);
        assert.equal(response.status, 200, `${path} 应返回 200`);
        return JSON.parse(text);
      };

      const overview = await api('/admin/api/overview');
      assert.equal(overview.namespace, 'work');
      assert.equal(overview.counts.sent, 1);
      assert.equal(overview.counts.failed, 1);
      assert.equal(overview.retryEnabled, false, '默认关闭重发，即使有 token 也不开放');

      const sent = await api('/admin/api/sent');
      assert.equal(sent.records.length, 1);
      assert.equal(sent.records[0].dedupeKey, sentKey);

      const failed = await api('/admin/api/failed');
      assert.equal(failed.records[0].status, 'failed');
      assert.ok(!failed.records[0].lastError.includes('hook.example.invalid'), 'URL 已脱敏');
      assert.ok(!failed.records[0].lastError.includes('ABCDEFGHIJKLMNOP'), '长串标识已脱敏');

      const channels = await api('/admin/api/channels');
      assert.equal(channels.records.length, 2);
      assert.deepEqual(channels.records.map((item: { channel: string }) => item.channel),
        ['email', 'webhook:0']);

      const upcoming = await api('/admin/api/upcoming');
      assert.equal(upcoming.items[0].kind, 'due');
      assert.equal(upcoming.items[0].taskId, 'task-u');

      const audit = await api('/admin/api/audit');
      assert.ok(audit.records.some((item: { action: string }) => item.action === 'auth_failed'),
        '鉴权失败要留审计痕迹');

      // 页面与所有 JSON 都不能出现任何凭据原文。
      for (const secret of Object.values(SECRETS)) {
        for (const text of responses) {
          assert.equal(text.includes(secret), false, '响应中出现了凭据原文');
        }
      }

      // 只读约束：非 GET 的数据接口不开放；/healthz 行为保持不变。
      const badMethod = await fetch(`${base}/admin/api/overview`, { method: 'POST', headers });
      assert.equal(badMethod.status, 404);
      const health = await fetch(`${base}/healthz`, {
        headers: { Authorization: `Bearer ${SECRETS.healthz}` },
      });
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    }, () => [upcomingItem]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('管理页：手动重发受总开关 + 鉴权双重保护，成功操作写审计日志', async () => {
  const dir = tempDir();
  const raw = channelDedupeKey('task-1:due:2026-11-13T09:00:00.000Z', 'email');
  const meta = { taskId: 'task-1', triggerType: 'due', triggerAt: 1, channel: 'email' };

  // 场景 1：总开关关闭，即便 token 正确也拒绝。
  {
    const config = testConfig({
      NOTIFY_ADMIN_TOKEN: SECRETS.admin,
      NOTIFY_ADMIN_RETRY: 'false',
      NOTIFY_NAMESPACE: 'off',
    });
    const store = await createStateStore(join(dir, 'off.sqlite'), config.namespace);
    try {
      store.markPending(raw, meta);
      store.markSent(raw);
      await withAdminServer(config, store, async base => {
        const response = await fetch(`${base}/admin/api/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SECRETS.admin },
          body: JSON.stringify({ dedupeKey: raw }),
        });
        assert.equal(response.status, 403);
        assert.equal(store.hasSent(raw), true, '被拒绝的请求不得改动记录');
        assert.ok(store.listAudit().some(item => item.action === 'retry_denied'));
      });
    } finally {
      store.close();
    }
  }

  // 场景 2：总开关打开但没有配置任何 token，入口必须仍然关闭。
  {
    const config = testConfig({ NOTIFY_ADMIN_RETRY: 'true', NOTIFY_NAMESPACE: 'notoken' });
    const store = await createStateStore(join(dir, 'notoken.sqlite'), config.namespace);
    try {
      await withAdminServer(config, store, async base => {
        const overview = await (await fetch(`${base}/admin/api/overview`)).json();
        assert.equal(overview.retryEnabled, false);
        const response = await fetch(`${base}/admin/api/retry`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dedupeKey: raw }),
        });
        assert.equal(response.status, 403);
      });
    } finally {
      store.close();
    }
  }

  // 场景 3：开关 + token 齐备，错误 token 拒绝，正确 token 才放行。
  {
    const config = testConfig({
      NOTIFY_ADMIN_TOKEN: SECRETS.admin,
      NOTIFY_ADMIN_RETRY: 'true',
      NOTIFY_NAMESPACE: 'on',
    });
    const store = await createStateStore(join(dir, 'on.sqlite'), config.namespace);
    try {
      store.markPending(raw, meta);
      store.markSent(raw);
      await withAdminServer(config, store, async base => {
        const post = (token: string) => fetch(`${base}/admin/api/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
          body: JSON.stringify({ dedupeKey: raw }),
        });

        const wrong = await post('wrong-token');
        assert.equal(wrong.status, 401);
        assert.equal(store.hasSent(raw), true);

        const ok = await post(SECRETS.admin);
        assert.equal(ok.status, 200);
        assert.equal(store.hasSent(raw), false, '记录已放回可重试状态');

        const entries = store.listAudit();
        assert.ok(entries.some(item => item.action === 'retry' && item.ok));
        assert.ok(entries.some(item => item.action === 'auth_failed' && !item.ok));
        for (const entry of entries) {
          assert.equal(entry.detail.includes(SECRETS.admin), false, '审计不得记录 token 原文');
        }

        const missing = await fetch(`${base}/admin/api/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SECRETS.admin },
          body: JSON.stringify({ dedupeKey: 'not-exist' }),
        });
        assert.equal(missing.status, 404);
      });
    } finally {
      store.close();
    }
  }

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 五、strict 一致性（M4 不改变任何 BASE 触发点）
// ---------------------------------------------------------------------------

test('strict 一致性：命名空间与 M4 开关都不改变触发计划集合', () => {
  const baseConfig = testConfig();
  const workConfig = testConfig({ NOTIFY_NAMESPACE: 'work', NOTIFY_ADMIN_RETRY: 'true' });
  const tasks = [
    makeTask({ dueDate: '2026-11-14T01:00:00Z' }),
    makeTask({ id: 'task-2', status: 'inbox', startTime: '2026-11-14T02:30:00Z' }),
  ];
  const shared = {
    tasks, projects: new Map(), now: NOW, strict: true, store: { getMeta: () => null },
  };
  const signature = (plan: ReturnType<typeof buildPlan>) =>
    plan.map(item => [item.kind, item.scheduledAt, item.dedupeKey]);

  const baseline = buildPlan({ ...shared, config: baseConfig });
  const namespaced = buildPlan({ ...shared, config: workConfig });
  assert.ok(baseline.length > 0, '样本任务应产生触发点');
  assert.deepEqual(signature(namespaced), signature(baseline),
    'M4 不得新增、删除或改写任何 BASE 触发点');
});

test('Scheduler.upcoming 只读计划缓存，不额外拉云端、不投递', async () => {
  const dir = tempDir();
  const config = testConfig();
  const store = await createStateStore(join(dir, 'state.sqlite'), config.namespace);
  let fetches = 0;
  const cloud = {
    fetchActiveTasks: async () => {
      fetches += 1;
      return {
        items: [makeTask({ dueDate: '2026-11-14T01:00:00Z' })],
        total: 1, pages: 1, stoppedBy: 'exhausted',
      };
    },
    fetchProjects: async () => [],
    health: async () => true,
    recordSuccess: () => ({ failures: 0, recovered: false }),
    recordFailure: () => ({ failures: 1 }),
    nextDelayMs: () => 1000,
    lastError: () => '',
  };
  const dispatcher = {
    channels: [] as string[],
    deliverChannel: async () => ({ ok: true, attempts: 1 }),
    deliver: async () => ({}),
  };

  try {
    const scheduler = createScheduler({
      config, cloud: cloud as never, store, dispatcher: dispatcher as never,
      now: () => NOW, log: () => {},
    });
    const dry = await scheduler.runOnce({ dryRun: true, strict: true });
    assert.equal(dry.planned > 0, true);
    assert.equal(dry.due, 0, 'dry-run 不投递');
    assert.equal(store.pendingCount(), 0, 'dry-run 不写投递记录');

    const before = fetches;
    const upcoming = scheduler.upcoming(10);
    assert.equal(fetches, before, '读取下一批提醒不得触发新的 Cloud 请求');
    assert.ok(upcoming.every(item => item.scheduledAt > NOW), '只列未来触发点');
    assert.ok(upcoming.length > 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
