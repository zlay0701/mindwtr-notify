/**
 * Notify 命令行入口
 *
 * 常用命令：
 *   npm run dry-run          跑一轮并只打印计划（strict，不投递、不写状态库）
 *   npm start                常驻运行 + /healthz
 *   node src/cli.ts --once   跑一轮后退出
 *   node src/cli.ts --test-email / --test-webhook    验证渠道配置
 *
 * 安全：全局只读访问 Cloud API；token 只在配置里读取，不出现在任何输出中。
 */

import { resolve } from 'node:path';
import { createAdminHandler } from './admin.ts';
import { loadConfig, validateConfig, type NotifyConfig } from './config.ts';
import { createCloudClient } from './cloud/client.ts';
import { describeError } from './errors.ts';
import { createLogger, LOG_LEVELS, parseLogLevel } from './logger.ts';
import { createDispatcher } from './dispatch/index.ts';
import { deliverPlatformWebhook } from './dispatch/adapters.ts';
import { createFileTransport, createSmtpTransport } from './dispatch/email.ts';
import type { EmailContent, NotifyMessage } from './dispatch/message.ts';
import { deliverWebhook } from './dispatch/webhook.ts';
import { startHealthz } from './healthz.ts';
import { createScheduler } from './scheduler.ts';
import { createStateStore } from './state/store.ts';

interface CliOptions {
  once: boolean;
  dryRun: boolean;
  strict: boolean;
  testEmail: boolean;
  testWebhook: boolean;
  help: boolean;
  /** --log-level=<级别> 的原始值；undefined 表示没传，走 .env 配置。 */
  logLevel?: string;
}

/** 手写参数解析，避免为几个开关引入依赖。 */
function parseArgs(argv: string[]): CliOptions {
  const levelArg = argv.find(item => item.startsWith('--log-level='));
  return {
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
    strict: argv.includes('--strict'),
    testEmail: argv.includes('--test-email'),
    testWebhook: argv.includes('--test-webhook'),
    help: argv.includes('--help') || argv.includes('-h'),
    logLevel: levelArg ? levelArg.slice('--log-level='.length) : undefined,
  };
}

const HELP = `Notify · Mindwtr 提醒中继服务

用法：node src/cli.ts [选项]

  --once          跑一轮后退出
  --dry-run       只打印本轮提醒计划，不投递、不写状态库（隐含 --once）
  --strict        强制关闭 A 类扩展，用于与官方规则做一致性比对
  --test-email    发一封测试邮件；未配置 SMTP 时写入 data/test-emails.txt
  --test-webhook  向第一个 Webhook URL 发一条测试消息
  --log-level=X   临时覆盖日志级别，优先级高于 NOTIFY_LOG_LEVEL
                  X = debug | info | warn | error | silent（默认 info）
  --help          显示本帮助

不带参数时为常驻模式，并监听 /healthz 与只读管理页 /admin。
管理页默认只读；手动重发需 NOTIFY_ADMIN_RETRY=true 且配置管理 token。
命令本身的输出（计划、投递结果、配置错误）始终显示，不受日志级别影响。
`;

/** 构造一条与业务无关的测试消息，用于验证渠道连通性。 */
function testPayload(config: ReturnType<typeof loadConfig>): { message: NotifyMessage; email: EmailContent } {
  return {
    message: {
      event: 'test',
      links: { app: config.baseUrl },
      sentAt: new Date().toISOString(),
    },
    email: {
      to: config.channels.email.to.length ? config.channels.email.to : ['unused@localhost'],
      subject: '[Notify] 测试邮件',
      text: '这是一封来自 Notify 的测试邮件。收到即说明 SMTP 配置正确。',
      html: '<div>这是一封来自 Notify 的测试邮件。收到即说明 SMTP 配置正确。</div>',
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  // 命令行显式给错的级别要立刻报错，否则用户会以为「debug 开了却没输出」。
  const cliLogLevel = args.logLevel === undefined ? null : parseLogLevel(args.logLevel);
  if (args.logLevel !== undefined && !cliLogLevel) {
    console.error(`日志级别无效：${args.logLevel}（可选 ${LOG_LEVELS.join(' / ')}）`);
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const overrides: Partial<NotifyConfig> = {};
  if (args.strict) overrides.strictMode = true;
  // 命令行覆盖优先级最高；同时清掉 .env 里那条「非法值」告警，避免误报。
  if (cliLogLevel) {
    overrides.logLevel = cliLogLevel;
    overrides.logLevelWarning = '';
  }
  const config = loadConfig({ root, overrides });

  // 配置错误属于「命令输出」，用 console.error 保证 silent 级别下也看得见。
  const problems = validateConfig(config);
  if (problems.length) {
    console.error('配置有误：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel, timezone: config.timezone });
  if (config.logLevelWarning) logger.warn(config.logLevelWarning);
  logger.debug('配置已加载', {
    namespace: config.namespace, timezone: config.timezone,
    pollSeconds: config.pollIntervalSeconds, strict: config.strictMode,
    logLevel: config.logLevel, statePath: config.statePath,
  });

  // M4：状态库按 namespace 隔离；默认命名空间与 M1–M3 完全兼容。
  const store = await createStateStore(config.statePath, config.namespace);
  const cloud = createCloudClient(config, fetch, logger);
  const dispatcher = createDispatcher(config);
  const scheduler = createScheduler({ config, cloud, store, dispatcher, logger });

  try {
    // 渠道自检：不需要完整轮询，单独跑完就退出。
    if (args.testEmail) {
      const payload = testPayload(config);
      const transport = createSmtpTransport(config)
        ?? createFileTransport(resolve(root, 'data/test-emails.txt'));
      await transport.send(payload.email);
      console.log(createSmtpTransport(config)
        ? '测试邮件已通过 SMTP 发送。'
        : '未配置 SMTP，测试邮件已写入 data/test-emails.txt。');
      return;
    }
    if (args.testWebhook) {
      const url = config.channels.webhook.urls[0];
      if (!url) {
        console.error('未配置 WEBHOOK_URLS，无法测试。');
        process.exitCode = 1;
        return;
      }
      const payload = testPayload(config);
      // 必须走与常驻投递相同的适配器：否则配了 wecom 却用 generic 的结构化 JSON 去测，
      // 企微会回 200 + errcode!=0，在 v1.15 之前被误判成「测试成功」。
      const kind = config.m3.adapters.kinds[0] ?? 'generic';
      const secret = config.m3.adapters.secrets[0] || config.channels.webhook.secret;
      const deliveryOptions = { maxAttempts: config.channels.webhook.maxAttempts };
      const result = kind === 'generic'
        ? await deliverWebhook(url, JSON.stringify(payload.message), config.channels.webhook.secret, deliveryOptions)
        : await deliverPlatformWebhook(kind, url, secret, payload.message, deliveryOptions);

      console.log(result.ok
        ? `Webhook 测试成功（适配器 ${kind}，第 ${result.attempts} 次尝试）。`
        : `Webhook 测试失败（适配器 ${kind}）：${result.error || '未知错误'}`);
      if (!result.ok) process.exitCode = 1;
      return;
    }

    // 单轮模式：dry-run 与 once 都在跑完一轮后退出。
    if (args.dryRun || args.once) {
      const result = await scheduler.runOnce({ dryRun: args.dryRun, strict: args.strict || config.strictMode });
      console.log(`本轮拉取 ${result.taskCount} 条任务、${result.projectCount} 个项目；计划 ${result.planned} 条，到点 ${result.due} 条，过期跳过 ${result.skippedLate} 条。`);
      if (result.errors.length) console.log(`错误：${result.errors.join('；')}`);
      if (args.dryRun) {
        const preview = result.plan.slice(0, 20);
        for (const item of preview) {
          const at = new Date(item.scheduledAt).toISOString();
          console.log(`  ${at}  ${item.kind.padEnd(16)} ${item.taskId ?? '-'}`);
        }
        if (result.plan.length > preview.length) console.log(`  … 另有 ${result.plan.length - preview.length} 条`);
        console.log('（dry-run：未投递、未写状态库）');
      } else {
        console.log(`投递成功 ${result.sent}，失败 ${result.failed}，重复跳过 ${result.duplicates}。`);
      }
      return;
    }

    // 常驻模式。只监听本机回环由 compose 的 ports 映射控制。
    // 管理页与 /healthz 共用一个端口，避免为只读页面再开一个对外端口。
    const admin = config.admin.enabled
      ? createAdminHandler({
          config,
          store,
          getStatus: () => scheduler.status(),
          upcoming: (limit?: number) => scheduler.upcoming(limit),
        })
      : undefined;
    const healthz = startHealthz(
      config.healthzPort, () => scheduler.status(), config.healthzToken, admin, logger,
    );
    scheduler.start(config.strictMode);
    const adminUrl = config.admin.enabled
      ? `，管理页 http://127.0.0.1:${config.healthzPort}/admin` : '';
    // 启动信息也属「命令输出」，常驻模式下让用户一眼确认当前生效的日志级别。
    console.log(`Notify 已启动（namespace=${config.namespace}，轮询 ${config.pollIntervalSeconds}s，日志级别=${config.logLevel}，/healthz:${config.healthzPort}${adminUrl}）。`);

    const shutdown = () => {
      scheduler.stop();
      void healthz.close().then(() => store.close()).then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error('运行失败', { reason: describeError(error) });
    store.close();
    process.exitCode = 1;
  }
}

void main();
