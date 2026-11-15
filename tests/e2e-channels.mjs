#!/usr/bin/env node
/**
 * 文件职责：目标 B「真实渠道端到端联调」的本地可复现执行器。
 *
 * 覆盖四个验收点：
 *   1. 邮件实发         —— 用 .env 里真实的 SMTP 配置发信（唯一对外动作）；
 *   2. Webhook 验签     —— 本地接收端用独立的 HMAC 实现校验签名、时间戳、篡改与错密钥；
 *   3. 渠道级独立重试   —— 邮件成功、Webhook 首次全失败，下一轮只重投 Webhook；
 *   4. 重启不重复投递   —— 连续三个独立 node 进程共用一个状态库，第三轮应零投递。
 *
 * 安全约束：
 *   - 不读取、不打印 .env 里的 MINDWTR_TOKEN / SMTP_PASS / SSH_URI；
 *     Cloud 地址临时指向本机 mock 且把 token 覆盖成假值，真实凭据不参与联调。
 *   - 不向任何真实 Mindwtr Cloud 实例发请求，不改云端数据（全程只碰本机 127.0.0.1）。
 *   - Webhook 只发到本机；状态库放在系统临时目录的独立命名空间，不污染工作区 data/。
 *   - 所有临时环境变量只在子进程里生效，绝不写回 .env。
 *
 * 用法（在项目根目录）：node tests/e2e-channels.mjs
 * 依赖：Node 22+，零第三方依赖。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录：本文件在 tests/ 下，上一级即根。 */
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 联调专用的 Webhook 密钥，只存在于内存与子进程环境变量里。 */
const WEBHOOK_SECRET = 'notify-e2e-local-secret';

/** 每个 CLI 子进程最长运行时间，防止 SMTP 卡住时整个脚本挂死。 */
const CLI_TIMEOUT_MS = 90_000;

/** 恒定时间比较两个十六进制签名字符串，长度不等直接判失败。 */
function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 监听随机本地端口，返回 Promise<{server, port}>。 */
function listen(server) {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

/**
 * 本地 Webhook 接收端：独立实现验签，不用项目里的 verifySignature，
 * 这样才算「接收方验证」而不是「被测代码自证」。
 *
 * @param secret 约定的 HMAC 密钥
 * @returns 接收端对象，含 mode 开关与 requests 记录
 */
function createWebhookReceiver(secret) {
  const requests = [];
  const state = { mode: 'ok' }; // 'ok' 返回 200，'fail' 返回 500 以触发重试

  const server = createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      const timestamp = Number(req.headers['x-notify-timestamp'] || 0);
      const signature = String(req.headers['x-notify-signature'] || '');
      const nowSec = Math.floor(Date.now() / 1000);

      const expected = 'sha256=' + createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`).digest('hex');
      // 对照 1：换一个密钥应该验不过，证明签名确实绑定密钥。
      const wrongSecret = 'sha256=' + createHmac('sha256', secret + '-wrong')
        .update(`${timestamp}.${rawBody}`).digest('hex');
      // 对照 2：正文末尾加一个空格应该验不过，证明签名绑定原始字节。
      const tampered = 'sha256=' + createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody} `).digest('hex');

      requests.push({
        at: Date.now(),
        fresh: Math.abs(nowSec - timestamp) <= 300,
        signatureOk: safeEqual(expected, signature),
        wrongSecretRejected: !safeEqual(wrongSecret, signature),
        tamperRejected: !safeEqual(tampered, signature),
        bodyBytes: Buffer.byteLength(rawBody),
        status: state.mode === 'fail' ? 500 : 200,
      });

      res.writeHead(state.mode === 'fail' ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(state.mode === 'fail' ? '{"ok":false}' : '{"ok":true}');
    });
  });

  return { server, requests, state };
}

/**
 * 本地 mock Cloud API：只实现只读白名单里的两个列表端点。
 * 四个状态各请求一次、都返回同一条任务，客户端会按 id 合并成 1 条。
 *
 * @param task 带 startTime 的任务，用来产生一个落在补发窗口内的触发点
 */
function createMockCloud(task) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Content-Type', 'application/json');

    if (pathname === '/v1/tasks') {
      res.writeHead(200);
      res.end(JSON.stringify({ tasks: [task], total: 1, limit: 100, offset: 0 }));
      return;
    }
    if (pathname === '/v1/projects') {
      res.writeHead(200);
      res.end(JSON.stringify({ projects: [], total: 0 }));
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200);
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return server;
}

/**
 * 跑一次 CLI 子进程。独立进程 == 一次「重启」，状态库靠文件路径持久化。
 *
 * @param args CLI 参数数组
 * @param env  注入的环境变量
 * @returns {code, stdout, stderr}
 */
function runCli(args, env) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`CLI 超时：${args.join(' ')}`));
    }, CLI_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', code => {
      clearTimeout(timer);
      ok({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** 从 CLI 输出里摘出「投递成功 N，失败 N，重复跳过 N」。 */
function parseDeliveryLine(stdout) {
  const match = stdout.match(/投递成功 (\d+)，失败 (\d+)，重复跳过 (\d+)/);
  if (!match) return null;
  return { sent: Number(match[1]), failed: Number(match[2]), duplicates: Number(match[3]) };
}

async function main() {
  // 只用系统临时目录，且只删本脚本自己创建的这一个目录。
  const workDir = mkdtempSync(join(tmpdir(), 'notify-e2e-'));
  const now = Date.now();
  const task = {
    id: 'e2e-task-1',
    title: '[NotifyE2E] 渠道联调',
    status: 'next',
    rev: 1,
    // 1 分钟前开始：落在 BASE-27 的 5 分钟补发窗口内，三轮联调期间不会过期。
    startTime: new Date(now - 60_000).toISOString(),
    dueDate: new Date(now + 3_600_000).toISOString(),
    reminderPolicy: 'inherit',
  };

  const hook = createWebhookReceiver(WEBHOOK_SECRET);
  const hookBound = await listen(hook.server);
  const cloudBound = await listen(createMockCloud(task));

  // 真实 SMTP_* 来自 .env（子进程自己读），这里不显式设置也不打印。
  // MINDWTR_TOKEN 覆盖成假值：真实 token 绝不会被发给任何服务。
  const env = {
    ...process.env,
    MINDWTR_BASE_URL: `http://127.0.0.1:${cloudBound.port}`,
    MINDWTR_TOKEN: 'e2e-local-dummy-token',
    NOTIFY_STATE_PATH: join(workDir, 'notify.sqlite'),
    NOTIFY_NAMESPACE: 'e2elocal',
    NOTIFY_STRICT: 'true',
    // 关掉三类摘要，让计划里只有上面那一个任务级触发点，结果不受运行时刻影响。
    NOTIFY_DIGEST_MORNING: 'false',
    NOTIFY_DIGEST_EVENING: 'false',
    NOTIFY_DIGEST_WEEKLY: 'false',
    WEBHOOK_ENABLED: 'true',
    WEBHOOK_URLS: `http://127.0.0.1:${hookBound.port}/hook`,
    WEBHOOK_SECRET,
    WEBHOOK_MAX_ATTEMPTS: '3',
  };

  const rounds = [];
  try {
    // ---- 阶段 1：--test-webhook 单独验签 ----
    hook.state.mode = 'ok';
    const probe = await runCli(['--test-webhook'], env);
    console.log('【阶段1 --test-webhook】 ' + probe.stdout.split('\n').filter(Boolean).pop());
    const probeRequest = hook.requests[0];

    // ---- 阶段 2：三轮独立进程 --once ----
    // 轮1：Webhook 全部返回 500（内部重试 3 次），邮件真实发出。
    hook.state.mode = 'fail';
    rounds.push(await runCli(['--once', '--strict'], env));

    const afterRound1 = hook.requests.length;
    // 轮2：Webhook 恢复 200；邮件应命中去重，只重投 Webhook。
    hook.state.mode = 'ok';
    rounds.push(await runCli(['--once', '--strict'], env));

    const afterRound2 = hook.requests.length;
    // 轮3：两个渠道都已 sent，应零投递、零新请求。
    rounds.push(await runCli(['--once', '--strict'], env));
    const afterRound3 = hook.requests.length;

    // ---- 汇总 ----
    const parsed = rounds.map(r => parseDeliveryLine(r.stdout));
    for (let i = 0; i < rounds.length; i += 1) {
      console.log(`【轮${i + 1}】 退出码=${rounds[i].code} 投递=${JSON.stringify(parsed[i])}`
        + ` | ` + rounds[i].stdout.split('\n')[0]);
      if (rounds[i].stderr) console.log('         stderr: ' + rounds[i].stderr.slice(0, 200));
    }

    const allRequests = hook.requests;
    const allValid = allRequests.length > 0 && allRequests.every(r =>
      r.fresh && r.signatureOk && r.wrongSecretRejected && r.tamperRejected && r.bodyBytes > 0);
    const checks = [
      ['--test-webhook 走真实 HTTP', probe.code === 0 && Boolean(probeRequest)],
      ['HMAC 验签 / 时间戳 / 错密钥 / 篡改正文', Boolean(allValid)],
      ['轮1 邮件成功且 Webhook 失败（独立成败）', parsed[0]?.sent === 1 && parsed[0]?.failed === 1],
      ['轮1 Webhook 内部重试 3 次', afterRound1 - 1 === 3],
      ['轮2 只重投 Webhook、邮件不重发', parsed[1]?.sent === 1 && parsed[1]?.duplicates === 1],
      ['轮3 重启后零投递', parsed[2]?.sent === 0 && parsed[2]?.failed === 0 && parsed[2]?.duplicates === 2],
      ['轮3 没有任何新 Webhook 请求', afterRound3 === afterRound2],
    ];
    console.log(`【请求统计】 总请求=${allRequests.length}（验签探针 1 + 轮1 ${afterRound1 - 1} + 轮2 ${afterRound2 - afterRound1} + 轮3 ${afterRound3 - afterRound2}）`);
    for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);

    const allPass = checks.every(([, ok]) => ok);
    console.log('【结论】 ' + (allPass ? '目标 B 四个验收点全部通过' : '存在未通过项，见上表'));
    process.exitCode = allPass ? 0 : 1;
  } finally {
    hook.server.close();
    cloudBound.server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('联调脚本失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
