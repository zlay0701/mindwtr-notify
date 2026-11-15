/**
 * M4 只读管理页（EXT-19 后半【官方无】）与受鉴权的手动重发入口
 *
 * 页面提供四块只读视图：已发记录、失败/待重试、渠道状态、下一批待触发提醒，
 * 外加审计日志。所有数据都来自本地 SQLite 与 Scheduler 的内存计划缓存，
 * 不重新拉取 Cloud API、不重算触发计划、不改动任何 BASE 规则。
 *
 * 只读边界（与项目硬约束一致）：
 *   1. 绝大多数接口是 GET；唯一的 POST 是 /admin/api/retry，它只改本地状态库的
 *      一条记录状态，绝不向 Mindwtr Cloud 发出任何请求，更不会触碰 /complete。
 *   2. 重发必须同时满足「NOTIFY_ADMIN_RETRY=true」+「配置了管理 token」+「token 校验通过」，
 *      三缺一即拒绝；重发本身也不是立即发送，而是把记录放回可重试状态，
 *      下一轮仍由 BASE-27 的 5 分钟补发窗口决定是否投递。
 *   3. 页面与所有 JSON 都不含 MINDWTR_TOKEN / 管理 token / Webhook URL / SMTP 密码 / 任务正文；
 *      token 只在浏览器里由用户临时输入，放在请求头，不进 URL、不进服务端日志。
 *
 * 为什么页面骨架不带数据：HTML 可以直接打开，但所有动态值都通过带鉴权的 API 获取，
 * 这样即使有人抓到页面源码也拿不到任何运行数据或凭据。前端渲染一律用 textContent。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NotifyConfig } from './config.ts';
import { tokenMatches, type AdminHandler } from './healthz.ts';
import type { SchedulerStatus, UpcomingItem } from './scheduler.ts';
import type { AuditRecord, SentRecord, StateStore } from './state/store.ts';

export interface AdminDeps {
  config: NotifyConfig;
  store: StateStore;
  /** /healthz 同款运行指标快照。 */
  getStatus: () => SchedulerStatus;
  /** Scheduler 已算好的计划缓存，只读。 */
  upcoming: (limit?: number) => UpcomingItem[];
  /** 可注入时钟，便于单元测试。 */
  now?: () => number;
}

/** 管理页对外开放的一条投递记录。错误文本经过脱敏。 */
interface PublicRecord extends Omit<SentRecord, 'lastError'> {
  lastError: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(html);
}

/**
 * 脱敏错误文本：失败原因里可能带 Webhook URL 或长串密钥，
 * 管理页是浏览器可见的界面，比日志更需要裁剪（EXT-03 数据最小化的延伸）。
 */
function redact(text: string | null): string {
  if (!text) return '';
  return text
    .replace(/https?:\/\/\S+/gi, '[URL 已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[长串标识已隐藏]')
    .slice(0, 200);
}

function toPublicRecord(record: SentRecord): PublicRecord {
  return {
    dedupeKey: record.dedupeKey,
    taskId: record.taskId,
    triggerType: record.triggerType,
    triggerAt: record.triggerAt,
    channel: record.channel,
    status: record.status,
    attempts: record.attempts,
    lastError: redact(record.lastError),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toPublicAudit(record: AuditRecord): AuditRecord {
  return { ...record, detail: redact(record.detail) };
}

/** 从请求头取管理 token。刻意不支持 ?token=：URL 会进浏览器历史与访问日志。 */
function providedToken(request: IncomingMessage): string {
  const header = request.headers['x-admin-token'];
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct) return direct;
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

/** 读取 POST 的 JSON 请求体，限制 4KB，避免管理接口被当成上传入口。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 4096) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

const READ_ROUTES = new Set([
  '/admin/api/overview',
  '/admin/api/sent',
  '/admin/api/failed',
  '/admin/api/channels',
  '/admin/api/upcoming',
  '/admin/api/audit',
]);

/**
 * 渲染自包含 HTML 页面（内联 CSS/JS，零外部资源）。
 * @param authRequired 是否配置了管理 token；只传布尔，不传任何凭据值
 */
function renderPage(authRequired: boolean): string {
  // 页面里的脚本刻意不使用模板字符串，避免与外层 TS 模板字符串的 ${} 冲突。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notify 管理台（只读）</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f6f7f9; color: #1f2329;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .sub { color: #6b7280; margin: 0 0 18px; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
         background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; }
  .bar input { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; min-width: 220px; }
  button { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px;
           background: #fff; color: #1f2329; cursor: pointer; }
  button:hover { background: #f3f4f6; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .tag { background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  #message { color: #b42318; margin-left: auto; }
  section { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
            padding: 16px 18px; margin-bottom: 16px; }
  .meta { color: #6b7280; font-size: 13px; margin: -6px 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
  th { color: #6b7280; font-weight: 600; background: #fafbfc; }
  td.mono { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .empty { color: #9ca3af; padding: 10px 0; }
  .pill { display: inline-block; border-radius: 4px; padding: 1px 7px; font-size: 12px; }
  .ok { background: #e8f5e9; color: #1b7f3b; }
  .bad { background: #fdecea; color: #b42318; }
  .warn { background: #fff4e5; color: #b54708; }
</style>
</head>
<body>
<main>
  <h1>Notify 管理台 <span class="tag">只读</span></h1>
  <p class="sub">已发记录 · 失败重试 · 渠道状态 · 下一批待触发提醒 · 审计日志</p>

  <div class="bar">
    <span>命名空间：<strong id="namespace">-</strong></span>
    <span id="auth-note" style="display:none">
      管理令牌 <input id="token" type="password" placeholder="NOTIFY_ADMIN_TOKEN / HEALTHZ_TOKEN" autocomplete="off">
    </span>
    <button id="refresh">刷新</button>
    <span id="message"></span>
  </div>

  <section>
    <h2>运行概览</h2>
    <div id="overview" class="meta">加载中…</div>
  </section>

  <section>
    <h2>已发记录</h2>
    <div class="meta">最近投递成功的记录（按更新时间倒序）</div>
    <table><thead><tr><th>时间</th><th>触发类型</th><th>任务 ID</th><th>渠道</th><th>状态</th><th>去重键</th></tr></thead>
      <tbody id="sent"></tbody></table><div id="sent-empty" class="empty" style="display:none">暂无记录</div>
  </section>

  <section>
    <h2>失败 / 待重试</h2>
    <div class="meta">失败、待投递与过期跳过的记录；「重发」只把记录放回可重试状态，实际投递仍受 5 分钟补发窗口约束</div>
    <table><thead><tr><th>时间</th><th>触发类型</th><th>任务 ID</th><th>渠道</th><th>状态</th><th>次数</th><th>错误（脱敏）</th><th>操作</th></tr></thead>
      <tbody id="failed"></tbody></table><div id="failed-empty" class="empty" style="display:none">暂无记录</div>
  </section>

  <section>
    <h2>渠道状态</h2>
    <div class="meta">每个渠道最近一次投递结果（取自状态库缓存，不主动探测外部服务）</div>
    <table><thead><tr><th>渠道</th><th>最近状态</th><th>最近时间</th></tr></thead>
      <tbody id="channels"></tbody></table><div id="channels-empty" class="empty" style="display:none">暂无记录</div>
  </section>

  <section>
    <h2>下一批待触发提醒</h2>
    <div class="meta">来自最近一轮计划的缓存，不重新拉取云端数据</div>
    <table><thead><tr><th>触发时间</th><th>触发类型</th><th>任务 ID</th><th>事件</th></tr></thead>
      <tbody id="upcoming"></tbody></table><div id="upcoming-empty" class="empty" style="display:none">暂无待触发提醒</div>
  </section>

  <section>
    <h2>审计日志</h2>
    <div class="meta">只记录管理操作与鉴权失败，不记录任何凭据原文</div>
    <table><thead><tr><th>时间</th><th>操作</th><th>主体</th><th>结果</th><th>详情（脱敏）</th></tr></thead>
      <tbody id="audit"></tbody></table><div id="audit-empty" class="empty" style="display:none">暂无记录</div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var AUTH_REQUIRED = ${authRequired ? 'true' : 'false'};
  var state = { retryEnabled: false, authenticated: false };
  var tokenInput = document.getElementById('token');
  var message = document.getElementById('message');

  // 令牌只存在当前标签页的会话里，不写 URL、不写 localStorage。
  tokenInput.value = sessionStorage.getItem('notify_admin_token') || '';
  if (AUTH_REQUIRED) document.getElementById('auth-note').style.display = 'inline';
  tokenInput.addEventListener('change', function () {
    sessionStorage.setItem('notify_admin_token', tokenInput.value.trim());
    refresh();
  });
  document.getElementById('refresh').addEventListener('click', refresh);

  function fmt(ms) {
    return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-';
  }
  function pill(status) {
    var span = document.createElement('span');
    span.className = 'pill ' + (status === 'sent' || status === true ? 'ok'
      : status === 'failed' ? 'bad' : 'warn');
    span.textContent = String(status);
    return span;
  }
  function cell(tr, value, mono) {
    var td = document.createElement('td');
    if (mono) td.className = 'mono';
    td.textContent = value === null || value === undefined || value === '' ? '-' : String(value);
    tr.appendChild(td);
    return td;
  }
  function rows(tbodyId, emptyId, list, build) {
    var tbody = document.getElementById(tbodyId);
    tbody.replaceChildren();
    document.getElementById(emptyId).style.display = list.length ? 'none' : 'block';
    for (var i = 0; i < list.length; i += 1) {
      var tr = document.createElement('tr');
      build(tr, list[i]);
      tbody.appendChild(tr);
    }
  }
  async function api(path, options) {
    var opts = options || {};
    var headers = opts.headers || {};
    var token = sessionStorage.getItem('notify_admin_token') || '';
    if (token) headers['X-Admin-Token'] = token;
    var response = await fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status));
    return data;
  }
  function retry(dedupeKey) {
    return api('/admin/api/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupeKey: dedupeKey })
    });
  }
  function refresh() {
    message.textContent = '';
    Promise.all([
      api('/admin/api/overview'), api('/admin/api/sent'), api('/admin/api/failed'),
      api('/admin/api/channels'), api('/admin/api/upcoming'), api('/admin/api/audit')
    ]).then(function (all) {
      var overview = all[0], sent = all[1], failed = all[2],
          channels = all[3], upcoming = all[4], audit = all[5];
      state.retryEnabled = !!overview.retryEnabled;
      state.authenticated = !!overview.authenticated;
      document.getElementById('namespace').textContent = overview.namespace;
      document.getElementById('overview').textContent =
        '已发 ' + overview.counts.sent + ' · 失败 ' + overview.counts.failed +
        ' · 待投递 ' + overview.counts.pending + ' · 过期跳过 ' + overview.counts.skipped_late +
        ' · 最近一轮计划 ' + overview.health.lastPlanCount + ' 条' +
        ' · 重发入口 ' + (state.retryEnabled ? '已启用（需鉴权）' : '已关闭');

      rows('sent', 'sent-empty', sent.records, function (tr, item) {
        cell(tr, fmt(item.updatedAt)); cell(tr, item.triggerType); cell(tr, item.taskId, true);
        cell(tr, item.channel); var td = cell(tr, ''); td.appendChild(pill(item.status));
        cell(tr, item.dedupeKey, true);
      });
      rows('failed', 'failed-empty', failed.records, function (tr, item) {
        cell(tr, fmt(item.updatedAt)); cell(tr, item.triggerType); cell(tr, item.taskId, true);
        cell(tr, item.channel); var td = cell(tr, ''); td.appendChild(pill(item.status));
        cell(tr, item.attempts); cell(tr, item.lastError);
        var action = document.createElement('td');
        if (state.retryEnabled && state.authenticated) {
          var button = document.createElement('button');
          button.textContent = '重发';
          button.addEventListener('click', function () {
            button.disabled = true;
            retry(item.dedupeKey).then(function () {
              message.textContent = '已排队重试：' + item.dedupeKey;
              refresh();
            }).catch(function (error) {
              button.disabled = false;
              message.textContent = error.message;
            });
          });
          action.appendChild(button);
        } else {
          action.textContent = state.retryEnabled ? '需鉴权' : '未启用';
        }
        tr.appendChild(action);
      });
      rows('channels', 'channels-empty', channels.records, function (tr, item) {
        cell(tr, item.channel); var td = cell(tr, ''); td.appendChild(pill(item.status));
        cell(tr, fmt(item.at));
      });
      rows('upcoming', 'upcoming-empty', upcoming.items, function (tr, item) {
        cell(tr, fmt(item.scheduledAt)); cell(tr, item.kind); cell(tr, item.taskId, true);
        cell(tr, item.event);
      });
      rows('audit', 'audit-empty', audit.records, function (tr, item) {
        cell(tr, fmt(item.at)); cell(tr, item.action); cell(tr, item.actor);
        var td = cell(tr, ''); td.appendChild(pill(item.ok)); cell(tr, item.detail);
      });
    }).catch(function (error) {
      message.textContent = error.message.indexOf('401') >= 0 || error.message.indexOf('Unauthorized') >= 0
        ? '未授权：请填写管理令牌后刷新' : error.message;
    });
  }
  refresh();
})();
</script>
</body>
</html>`;
}

/**
 * 创建管理页处理器（M4 · EXT-19【官方无】；不改变任何 BASE 触发点）。
 * @returns AdminHandler，交给 startHealthz 做 /admin 前缀下的路由分派
 */
export function createAdminHandler(deps: AdminDeps): AdminHandler {
  const { config, store, getStatus, upcoming } = deps;
  const authRequired = Boolean(config.admin.token);
  // 重发真正可用 = 显式开启 + 有 token。无 token 时入口一律关闭，满足 spec §14 验收。
  const retryAvailable = config.admin.retryEnabled && authRequired;
  const limit = Math.max(1, Math.min(config.admin.maxRecords, 500));

  function audit(action: string, actor: string, detail: string, ok: boolean): void {
    store.addAudit({ action, actor, detail, ok });
  }

  /** 所有 /admin/api/* 统一鉴权；页面 HTML 不含数据，所以不需要鉴权即可打开。 */
  function authorized(request: IncomingMessage): boolean {
    if (!authRequired) return true;
    return tokenMatches(providedToken(request), config.admin.token);
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const pathname = url.pathname;

    // 页面骨架：不含任何运行数据或凭据值。
    if (request.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      sendHtml(response, renderPage(authRequired));
      return true;
    }

    if (!pathname.startsWith('/admin/api/')) return false;

    // 只读接口一律 GET；写接口只有 retry 一个且必须是 POST。
    const isRead = request.method === 'GET' && READ_ROUTES.has(pathname);
    const isRetry = request.method === 'POST' && pathname === '/admin/api/retry';
    if (!isRead && !isRetry) return false;

    if (!authorized(request)) {
      // 审计里只记路径与结果，绝不记用户提交的 token 值。
      audit('auth_failed', 'anonymous', pathname, false);
      sendJson(response, 401, { ok: false, message: 'Unauthorized' });
      return true;
    }
    const actor = authRequired ? 'admin' : 'local';

    if (isRetry) {
      if (!retryAvailable) {
        audit('retry_denied', actor, pathname, false);
        sendJson(response, 403, {
          ok: false,
          message: '手动重发未启用或缺少鉴权凭据（需 NOTIFY_ADMIN_RETRY=true 与管理 token）',
        });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch {
        audit('retry_bad_request', actor, pathname, false);
        sendJson(response, 400, { ok: false, message: '请求体不是合法 JSON 或超过 4KB' });
        return true;
      }
      const dedupeKey = typeof body.dedupeKey === 'string' ? body.dedupeKey : '';
      if (!dedupeKey || dedupeKey.length > 500) {
        audit('retry_bad_request', actor, pathname, false);
        sendJson(response, 400, { ok: false, message: '缺少合法的 dedupeKey' });
        return true;
      }
      const ok = store.requestRetry(dedupeKey);
      audit('retry', actor, dedupeKey, ok);
      sendJson(response, ok ? 200 : 404, {
        ok,
        message: ok
          ? '已放回可重试状态；实际投递由下一轮调度按补发窗口决定'
          : '未找到该记录',
      });
      return true;
    }

    switch (pathname) {
      case '/admin/api/overview': {
        const status = getStatus();
        sendJson(response, 200, {
          namespace: config.namespace,
          authRequired,
          authenticated: true,
          retryEnabled: retryAvailable,
          health: status,
          counts: store.recordCounts(),
        });
        return true;
      }
      case '/admin/api/sent':
        sendJson(response, 200, {
          records: store.listRecords({ statuses: ['sent'], limit }).map(toPublicRecord),
        });
        return true;
      case '/admin/api/failed':
        // pending / failed / skipped_late 都算「还没成功」，放在一起便于排障。
        sendJson(response, 200, {
          records: store.listRecords({
            statuses: ['failed', 'pending', 'skipped_late'], limit,
          }).map(toPublicRecord),
        });
        return true;
      case '/admin/api/channels': {
        const channels = getStatus().channelStatus;
        const records = Object.entries(channels)
          .map(([channel, value]) => ({ channel, status: value.status, at: value.at }))
          .sort((left, right) => left.channel.localeCompare(right.channel));
        sendJson(response, 200, { records });
        return true;
      }
      case '/admin/api/upcoming':
        sendJson(response, 200, { items: upcoming(limit) });
        return true;
      case '/admin/api/audit':
        sendJson(response, 200, {
          records: store.listAudit(limit).map(toPublicAudit),
        });
        return true;
      default:
        return false;
    }
  }

  return { handle };
}
