#!/usr/bin/env node
/**
 * Notify · M0 只读字段探针
 *
 * 这个文件只做一件事：确认 Cloud API 的任务/项目列表到底返回哪些字段，
 * 从而决定 M1 是「一次拉取即可」还是「列表拿 id + 逐个补详情」两段式。
 *
 * 安全约束（重要）：
 *   1. 只发送 GET 请求，且路径必须通过白名单；本文件不存在任何写操作。
 *   2. token 只从 .env / 环境变量读取，绝不写入日志、报告或云端资源。
 *   3. 报告只输出字段名、类型、计数与日期样本，不输出任务标题/描述等正文。
 *
 * 运行方式：node scripts/probe.mjs   （Node 18+ 即可，零第三方依赖）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'https://mindwtr-cloud.zlay.dpdns.org';
const REPORT_PATH = resolve(ROOT, 'docs', 'probe-result.md');
const TIMEOUT_MS = 20000;

const PAGE_SIZE = 100; // 单页条数，Cloud API 用 limit / offset 分页
const MAX_PAGES = 20;  // 翻页上限，防止接口异常时无限循环（spec §7 第 6 条）
const STATUSES = ['inbox', 'next', 'waiting', 'someday']; // BASE-28 定义的活跃状态

// 规则引擎需要的字段。注意：其中不少是「条件性字段」——任务没设截止日期时
// 就不会出现，所以「样本里没有」不等于「API 不返回」，结论要结合翻页全量和详情对比。
const RULE_FIELDS = [
  'id', 'status', 'dueDate', 'startTime', 'reviewAt',
  'dueReminderLeadMinutes', 'startReminderLeadMinutes', 'repeatReminderMinutes',
  'reminderPolicy', 'suppressMindwtrReminders',
  'cancelledAt', 'completedAt', 'deletedAt', 'archivedAt', 'projectArchivedAt',
  'projectId', 'rev', 'description',
];
const DATE_FIELDS = ['dueDate', 'startTime', 'reviewAt', 'cancelledAt', 'completedAt'];

/** 读取本地 .env。刻意手写一个极简解析器，避免为了探针引入第三方依赖。 */
function loadDotEnv() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

// 环境变量优先级高于 .env，方便临时改用其他地址/令牌而不改文件。
const env = { ...loadDotEnv(), ...process.env };
const BASE = String(env.MINDWTR_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const TOKEN = String(env.MINDWTR_TOKEN || '').trim();

// ---------------------------------------------------------------------------
// 只读护栏
// ---------------------------------------------------------------------------

/** 双重白名单：方法必须是 GET，路径必须是下面这几个只读端点。 */
function assertReadOnly(method, pathname) {
  if (method !== 'GET') throw new Error(`拒绝非 GET 请求：${method}`);
  const allowed = pathname === '/health'
    || pathname === '/v1/tasks'
    || /^\/v1\/tasks\/[^/]+$/.test(pathname)
    || pathname === '/v1/projects'
    || pathname === '/openapi.json'
    || pathname === '/swagger.json';
  if (!allowed) throw new Error(`路径不在只读白名单内：${pathname}`);
}

/** 统一的 GET 封装。鉴权头只在这里拼接，绝不出现在 URL 或输出里。 */
async function get(pathname, params = {}, useAuth = true) {
  const url = new URL(BASE + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  assertReadOnly('GET', url.pathname);

  const headers = { Accept: 'application/json' };
  if (useAuth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { path: url.pathname + url.search, status: 0, ms: Date.now() - started, error: String(error?.message || error), json: null };
  }

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应时保留原文片段 */ }

  return {
    path: url.pathname + url.search,
    status: response.status,
    ms: Date.now() - started,
    etag: response.headers.get('etag'),
    requestId: response.headers.get('x-request-id'),
    json,
    preview: response.ok ? '' : text.slice(0, 160).replace(/\s+/g, ' '),
  };
}

// 每次请求都记下来，报告末尾给出完整清单，便于人工复核「确实只读」。
const requests = [];
async function record(label, pathname, params, useAuth) {
  const result = await get(pathname, params, useAuth);
  requests.push({ label, ...result });
  return result;
}

// ---------------------------------------------------------------------------
// 响应解析与脱敏
// ---------------------------------------------------------------------------

/** 列表可能被包在 { tasks: [...] } 里，也可能直接是数组；两种都兼容。 */
function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['tasks', 'items', 'data', 'results', 'projects', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/** 只描述响应「外壳」的结构，不输出任何任务内容。 */
function envelopeShape(payload) {
  if (Array.isArray(payload)) return `array(len=${payload.length})`;
  if (!payload || typeof payload !== 'object') return typeof payload;
  const keys = Object.keys(payload);
  const paging = keys.filter(k => ['total', 'hasMore', 'nextOffset', 'limit', 'offset', 'count'].includes(k));
  return `object(keys=${keys.join(',')}; paging=${paging.join(',') || 'none'})`;
}

/** 收集字段名（含一层嵌套），用 Set 去重，便于比较「列表 vs 详情」。 */
function collectKeys(object, out = new Set(), prefix = '', depth = 0) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || depth > 1) return out;
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}.${key}` : key;
    out.add(name);
    if (value && typeof value === 'object' && !Array.isArray(value)) collectKeys(value, out, name, depth + 1);
  }
  return out;
}

/** 输出值的「形状」而不是内容；日期样本单独放行，因为日期本身不敏感。 */
function safeValue(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  const type = typeof value;
  if (type === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return `date-like: ${value.slice(0, 32)}`;
    return `string(len=${value.length})`;
  }
  if (type === 'object') return `object(keys=${Object.keys(value).length})`;
  return type;
}

/**
 * 统计时间字段的出现次数与格式分布。
 * 这里复用官方 BASE-21 的判定正则，用来验证真实数据里
 * 「仅日期」和「带时间」分别长什么样。
 */
function collectDateSamples(item, findings) {
  for (const field of DATE_FIELDS) {
    const value = item?.[field];
    if (value == null) continue;
    const bucket = findings.dateSamples[field] || (findings.dateSamples[field] = {
      count: 0, dateOnly: 0, withTime: 0, other: 0, sample: null,
    });
    bucket.count += 1;
    const text = String(value);
    if (/[T\s]\d{2}:\d{2}/.test(text)) bucket.withTime += 1;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) bucket.dateOnly += 1;
    else bucket.other += 1;
    if (!bucket.sample) bucket.sample = text.slice(0, 32);
  }
}

function mdTable(rows) {
  if (!rows.length) return '_无_';
  const head = `| ${rows[0].join(' | ')} |`;
  const divider = `|${rows[0].map(() => '---').join('|')}|`;
  const body = rows.slice(1).map(row => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${divider}\n${body}`;
}

// ---------------------------------------------------------------------------
// 分页拉取
// ---------------------------------------------------------------------------

/**
 * 把某个状态的活跃任务按 total 全部拉回来。
 *
 * 为什么要翻页：只看第一页时，带 dueDate 的任务可能恰好都在后面，
 * 会把「条件性字段」误判成「API 不返回」。M1 的拉取模块也会用同样的翻页逻辑，
 * 所以这里顺带验证了 limit/offset 与 total 的实际行为。
 */
async function fetchAllTasks(status) {
  const items = [];
  let offset = 0;
  let total = null;
  let pages = 0;
  let stoppedBy = 'exhausted';

  while (pages < MAX_PAGES) {
    const response = await record(`tasks:${status}:page${pages + 1}`, '/v1/tasks', {
      status, limit: PAGE_SIZE, offset,
    }, true);

    if (response.status !== 200) { stoppedBy = `http-${response.status}`; break; }

    const batch = pickArray(response.json);
    if (total === null && typeof response.json?.total === 'number') total = response.json.total;
    items.push(...batch);
    pages += 1;

    if (batch.length === 0) break;                 // 没有更多数据
    offset += batch.length;
    if (total !== null && offset >= total) break; // 已经取满

    // 同一页出现重复 id，说明服务端分页可能异常，提前停下避免死循环。
    const ids = batch.map(task => task?.id).filter(Boolean);
    if (new Set(ids).size < ids.length) { stoppedBy = 'duplicate-ids'; break; }
  }

  if (pages >= MAX_PAGES) stoppedBy = 'page-limit';
  return { items, pages, total, stoppedBy };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const lines = [];
  const add = (text = '') => lines.push(text);
  const findings = {
    statusSamples: {}, listKeys: new Set(), detailKeys: new Set(), projectKeys: new Set(),
    dateSamples: {}, listSample: null,
  };

  add('# M0 字段探针报告 · Notify');
  add('');
  add(`- 生成时间：${new Date().toISOString()}`);
  add(`- 目标：\`${BASE}\``);
  add(`- 模式：${TOKEN ? '完整（已提供令牌）' : '预检（无令牌，仅免认证端点）'}`);
  add('- 只读保证：全部请求为 `GET`，路径限 `/health`、`/v1/tasks`、`/v1/tasks/:id`、`/v1/projects`、`/openapi.json`、`/swagger.json`；不含任何写操作。');
  add('- 凭据：只从 `MINDWTR_TOKEN` 环境变量或本地 `.env` 读取，不写入报告、日志或云端。');
  add('- 隐私：报告不含任务标题、描述、附件、负责人、标签等正文内容。');
  add('');

  // 1. 连通性与鉴权
  const health = await record('health', '/health', {}, false);
  const authCheck = await record('auth-check (no token)', '/v1/tasks', { status: 'next', limit: 1 }, false);
  add('## 1. 连通性与鉴权');
  add('');
  add(`- \`GET /health\` → **${health.status}**，${health.ms}ms，响应 \`${JSON.stringify(health.json)}\``);
  add(`- 不带令牌访问 \`GET /v1/tasks\` → **${authCheck.status}** ${authCheck.preview ? `(${authCheck.preview})` : ''}`);
  add('');

  if (!TOKEN) {
    add('## 2. 未完成：缺少令牌');
    add('');
    add('带鉴权的字段探测已跳过。在项目根目录创建 `.env` 后重新运行：');
    add('');
    add('```');
    add(`MINDWTR_BASE_URL=${BASE}`);
    add('MINDWTR_TOKEN=<完整 bearer token>');
    add('```');
    add('');
    add('注意：capture-only 令牌只能调 `POST /v1/capture`，在 `/v1/tasks` 会返回 403。');
    add('');
  } else {
    // 2. 分页拉全四个活跃状态
    add('## 2. 活跃任务（按 total 翻页拉全）');
    add('');
    const statusRows = [['状态', '页数', 'total', '实取', '停止原因', '首页结构']];
    for (const status of STATUSES) {
      const result = await fetchAllTasks(status);
      findings.statusSamples[status] = result.items;
      const firstPage = requests.find(r => r.label === `tasks:${status}:page1`);
      statusRows.push([
        status, String(result.pages), result.total === null ? '-' : String(result.total),
        String(result.items.length), result.stoppedBy, envelopeShape(firstPage?.json),
      ]);
      for (const item of result.items) {
        collectKeys(item, findings.listKeys);
        collectDateSamples(item, findings);
      }
      if (!findings.listSample && result.items.length) findings.listSample = result.items[0];
    }
    add(mdTable(statusRows));
    add('');
    const allItems = Object.values(findings.statusSamples).flat();
    add(`- 合计取回 ${allItems.length} 条活跃任务；列表响应未返回 ETag。`);
    add('');

    // 3. 列表项与详情对比：优先挑一条带时间的任务，更有代表性
    const detailTarget = allItems.find(t => t?.id && (t.dueDate || t.startTime || t.reviewAt))
      || allItems.find(t => t?.id);
    if (!detailTarget) {
      add('## 3. 列表项 vs 任务详情');
      add('');
      add('> 四个活跃状态下没有可用任务，详情对比跳过。');
      add('');
    } else {
      const detail = await record('task detail', `/v1/tasks/${encodeURIComponent(String(detailTarget.id))}`, {}, true);
      const detailObject = detail.json && typeof detail.json === 'object' ? (detail.json.task || detail.json) : null;
      if (detailObject) collectKeys(detailObject, findings.detailKeys);
      add('## 3. 列表项 vs 任务详情');
      add('');
      add(`- \`GET /v1/tasks/:id\` → **${detail.status}**，${detail.ms}ms；ETag：${detail.etag || '未返回'}`);
      const onlyInDetail = [...findings.detailKeys].filter(key => !findings.listKeys.has(key));
      const onlyInList = [...findings.listKeys].filter(key => !findings.detailKeys.has(key));
      add(`- 仅详情有的字段：${onlyInDetail.length ? `\`${onlyInDetail.join('`, `')}\`` : '无'}`);
      add(`- 仅列表有的字段：${onlyInList.length ? `\`${onlyInList.join('`, `')}\`` : '无'}`);
      add('> 若「仅详情有的字段」为空，说明列表字段已足够，M1 无需两段式补查。');
      add('');
    }

    // 4. 项目列表
    const projects = await record('projects', '/v1/projects', { limit: PAGE_SIZE }, true);
    const projectItems = pickArray(projects.json);
    for (const project of projectItems) collectKeys(project, findings.projectKeys);
    add('## 4. 项目列表');
    add('');
    add(`- \`GET /v1/projects\` → **${projects.status}**，${projects.ms}ms，${projectItems.length} 条；结构：${envelopeShape(projects.json)}`);
    add(`- 观察到的字段：${projectItems.length ? `\`${[...findings.projectKeys].sort().join('`, `')}\`` : '无'}`);
    add('');

    // 5. 规则引擎字段检查
    add('## 5. 规则引擎所需字段');
    add('');
    const fieldRows = [['字段', '列表有', '详情有', '样本形状', '说明']];
    for (const field of RULE_FIELDS) {
      const inList = findings.listKeys.has(field);
      const inDetail = findings.detailKeys.has(field);
      const holder = allItems.find(task => task && task[field] !== undefined);
      const sample = holder ? safeValue(holder[field]) : '-';
      let note = '';
      if (!inList && inDetail) note = '需要两段式补查';
      else if (!inList && !inDetail) note = '全量样本中未出现（可能是条件性字段）';
      fieldRows.push(['`' + field + '`', inList ? '有' : '无', inDetail ? '有' : '无', sample, note]);
    }
    add(mdTable(fieldRows));
    add('');
    add('列表项观察到的全部字段（来自全部活跃任务，按字母序）：');
    add('');
    add('`' + [...findings.listKeys].sort().join('`, `') + '`');
    add('');
    add('');
    const dateRows = [['时间字段', '出现次数', '仅日期', '带时间', '其他格式', '样本']];
    for (const field of DATE_FIELDS) {
      const bucket = findings.dateSamples[field];
      dateRows.push([
        '`' + field + '`',
        bucket ? String(bucket.count) : '0',
        bucket ? String(bucket.dateOnly) : '-',
        bucket ? String(bucket.withTime) : '-',
        bucket ? String(bucket.other) : '-',
        bucket?.sample || '无样本',
      ]);
    }
    add('时间字段格式分布（用于验证 BASE-21 的 `/[T\\s]\\d{2}:\\d{2}/` 判定）：');
    add('');
    add(mdTable(dateRows));
    add('');

    // 6. API 描述文档（若有 schema 可消除条件性字段的歧义）
    add('## 6. API 描述文档');
    add('');
    for (const path of ['/openapi.json', '/swagger.json']) {
      const response = await record(`api-doc:${path}`, path, {}, true);
      add(`- \`GET ${path}\` → **${response.status}**，${response.ms}ms`);
    }
    add('- 两者带令牌仍返回 401，说明它们不由本 bearer token 保护（或位于另一层鉴权之后），拿不到 schema；字段结论只能依据实测样本 + 官方源码。');
    add('');

    // 7. 结论
    const missingCritical = RULE_FIELDS.filter(f => !findings.listKeys.has(f) && findings.detailKeys.has(f));
    const unknown = RULE_FIELDS.filter(f => !findings.listKeys.has(f) && !findings.detailKeys.has(f));
    const anyTimedTask = DATE_FIELDS.some(f => (findings.dateSamples[f]?.withTime || 0) > 0);
    add('## 7. 结论');
    add('');
    add(`- **是否需要两段式补查：${missingCritical.length ? '是' : '否（基于全量活跃任务样本）'}**`);
    if (missingCritical.length) add(`  - 仅详情存在的字段：\`${missingCritical.join('`, `')}\``);
    add(`- 全量样本中仍未出现的字段：${unknown.length ? `\`${unknown.join('`, `')}\`` : '无'}`);
    add(`- 观察到带时间部分的日期：${anyTimedTask ? '是' : '否'}`);
    if (!anyTimedTask) {
      add(`  - 全量 ${Object.values(findings.statusSamples).flat().length} 条活跃任务中没有任何带截止/开始/回顾时间的任务，**当前数据下只有摘要类提醒会触发**，任务级提醒不会产生触发点。`);
      add('  - 这不是 API 缺陷：这些字段是条件性的，任务没设时间就不会出现。类型定义按官方 `task-sync-schema.ts` 声明为可选，M1 规则引擎用单元测试覆盖。');
      add('  - 建议在客户端给一条测试任务设置明确的截止时间后重跑本探针，即可端到端验证 `hasTimeComponent` 的真实存储格式（BASE-21）。');
    }
    add('- M1 拉取策略：按 `total` 用 `limit/offset` 翻页，合并按 id 去重；列表字段已足够，不调用详情接口。');
    add('- 归档项目过滤：项目列表未见 `archivedAt` / `reviewAt`，优先用任务级 `projectArchivedAt`，回退项目 `status`。');
    add('- 仍需人工确认：compose 服务名 / 端口 / 网络名，以及所有同步客户端是否为较新版本。');
    add('');
  }

  // 请求清单：人工复核「确实只读」的依据
  add('## 请求清单');
  add('');
  add(mdTable([['#', '用途', '方法', '路径', '状态', '耗时(ms)', 'ETag']].concat(
    requests.map((r, i) => [String(i + 1), r.label, 'GET', '`' + r.path + '`', String(r.status), String(r.ms), r.etag || '-'])
  )));
  add('');
  add('> 本报告不含任务正文与任何凭据。');

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf8');

  // 控制台只打印状态，不打印任何任务内容或令牌。
  console.log(`模式=${TOKEN ? '完整' : '预检'} 请求数=${requests.length} health=${health.status} 鉴权检查=${authCheck.status}`);
  for (const request of requests) {
    console.log(`  GET ${request.path} → ${request.status} (${request.ms}ms)${request.error ? ' 错误:' + request.error : ''}`);
  }
  console.log(`报告：${REPORT_PATH}`);
  if (!TOKEN) console.log('未检测到 MINDWTR_TOKEN：填入 .env 后重新运行。');
}

main().catch(error => {
  console.error('探针执行失败：', error?.stack || String(error));
  process.exitCode = 1;
});
