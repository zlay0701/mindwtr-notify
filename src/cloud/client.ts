/**
 * 只读 Cloud API 客户端（EXT-09【增强】、EXT-15【官方无】纯只读边界）
 *
 * 职责：把四个活跃状态的任务按 total 翻页拉全、按 id 合并（冲突时取 rev 较大的），
 * 并缓存项目列表供项目名与归档过滤使用。
 *
 * 安全约束（与 M0 探针一致）：
 *   1. 只发 GET，路径走白名单；本文件不存在写请求。
 *   2. token 只放在 Authorization 头，绝不拼进 URL、日志或异常信息。
 *   3. 分页有上限保护，避免接口异常时无限循环（spec §7 第 6 条）。
 */

import { describeError } from '../errors.ts';
import { createLogger, type Logger } from '../logger.ts';
import type { NotifyConfig } from '../config.ts';
import type { MindwtrProject, MindwtrTask } from '../types.ts';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DEFAULT_STATUSES = ['inbox', 'next', 'waiting', 'someday'];
const PROJECT_CACHE_MS = 10 * 60_000;

/** 只读路径白名单。动态 id 用正则放行，其余一概拒绝。 */
function assertReadOnly(method: string, pathname: string): void {
  if (method !== 'GET') throw new Error(`拒绝非 GET 请求：${method}`);
  const allowed = pathname === '/health'
    || pathname === '/v1/tasks'
    || /^\/v1\/tasks\/[^/]+$/.test(pathname)
    || pathname === '/v1/projects';
  if (!allowed) throw new Error(`路径不在只读白名单内：${pathname}`);
}

/** 列表响应可能是数组，也可能包在 { tasks: [...] } / { projects: [...] } 里。 */
function pickArray(payload: unknown, hint: 'tasks' | 'projects'): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of [hint, 'items', 'data', 'results']) {
    if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

export interface FetchResult<T> {
  items: T[];
  total: number | null;
  pages: number;
  stoppedBy: string;
}

export interface CloudClient {
  /** 拉取全部活跃任务（四状态 + 可选 reference）。 */
  fetchActiveTasks(): Promise<FetchResult<MindwtrTask>>;
  /** 拉取项目列表，结果缓存 10 分钟。 */
  fetchProjects(force?: boolean): Promise<MindwtrProject[]>;
  /** 连通性探测。 */
  health(): Promise<boolean>;
  /** 记录一次成功/失败，返回连续失败次数与是否刚恢复。 */
  recordSuccess(): { failures: number; recovered: boolean };
  recordFailure(message?: string): { failures: number };
  /** 连续失败后的退避时长（毫秒），最长由配置限制。 */
  nextDelayMs(): number;
  /** 最近一次错误摘要，供 healthz 使用（不含 token 与任务内容）。 */
  lastError(): string;
}

/**
 * 创建客户端。
 * @param config     运行配置（只用 baseUrl / token / logLevel 等，不打印凭据）
 * @param fetchImpl  可注入的 fetch，便于单元测试用假数据验证分页逻辑而不打真实 API
 * @param logger     EXT-20【官方无】分级日志器；不传时按 config.logLevel 自动创建
 */
export function createCloudClient(
  config: NotifyConfig,
  fetchImpl: typeof fetch = fetch,
  logger: Logger = createLogger({ level: config.logLevel, timezone: config.timezone }),
): CloudClient {
  let consecutiveFailures = 0;
  let hadFailure = false;
  let lastErrorMessage = '';
  let projectCache: MindwtrProject[] = [];
  let projectCacheAt = 0;

  /** 统一的 GET 封装；所有对外请求都必须经过这里。 */
  async function get(pathname: string, params: Record<string, string | number> = {}): Promise<{
    status: number; json: unknown;
  }> {
    assertReadOnly('GET', pathname);
    const url = new URL(config.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    // debug 只记路径与查询参数名值，绝不打印 url 全文、Authorization 头或响应体：
    // 这些信息里可能出现 token / Webhook 地址。
    const query = Object.entries(params).map(([key, value]) => `${key}=${value}`).join('&');
    const startedAt = Date.now();
    logger.debug('Cloud GET 开始', { path: pathname, query: query || '-' });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.token}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // 网络层错误在 VPS 上很常见（例如出站被拒），debug 里给出去脱敏后的原因。
      logger.debug('Cloud GET 网络异常', { path: pathname, reason: describeError(error) });
      throw error;
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应按空处理 */ }

    if (!response.ok) {
      // 只记录状态码与简短原因，绝不回显响应体里可能包含的凭据信息。
      logger.debug('Cloud GET 非成功状态', { path: pathname, status: response.status });
      throw new Error(`GET ${url.pathname} 返回 ${response.status}`);
    }
    logger.debug('Cloud GET 完成', {
      path: pathname, status: response.status, ms: Date.now() - startedAt,
    });
    return { status: response.status, json };
  }

  /** 按 total 翻页拉回单个状态的全部任务。 */
  async function fetchStatus(status: string): Promise<{ items: MindwtrTask[]; total: number | null; pages: number; stoppedBy: string }> {
    const items: MindwtrTask[] = [];
    let offset = 0;
    let total: number | null = null;
    let pages = 0;
    let stoppedBy = 'exhausted';

    while (pages < MAX_PAGES) {
      const response = await get('/v1/tasks', { status, limit: PAGE_SIZE, offset });
      const batch = pickArray(response.json, 'tasks') as MindwtrTask[];
      const envelope = response.json as Record<string, unknown> | null;
      if (total === null && typeof envelope?.total === 'number') total = envelope.total;

      items.push(...batch);
      pages += 1;
      if (batch.length === 0) break;
      offset += batch.length;
      if (total !== null && offset >= total) break;

      // 同页重复 id 说明分页异常，提前停止，避免死循环。
      const ids = batch.map(task => task?.id).filter(Boolean);
      if (new Set(ids).size < ids.length) { stoppedBy = 'duplicate-ids'; break; }
    }
    if (pages >= MAX_PAGES) stoppedBy = 'page-limit';
    return { items, total, pages, stoppedBy };
  }

  return {
    async fetchActiveTasks() {
      const statuses = config.officialRules.includeReference
        ? [...DEFAULT_STATUSES, 'reference']
        : DEFAULT_STATUSES;

      // 同一任务可能出现在多个状态的响应里，按 id 去重、按 rev 取新。
      const merged = new Map<string, MindwtrTask>();
      let total = 0;
      let pages = 0;
      const stops: string[] = [];

      for (const status of statuses) {
        const result = await fetchStatus(status);
        pages += result.pages;
        if (result.total !== null) total += result.total;
        if (result.stoppedBy !== 'exhausted') stops.push(`${status}:${result.stoppedBy}`);
        for (const task of result.items) {
          if (!task || typeof task.id !== 'string') continue;
          const previous = merged.get(task.id);
          if (!previous || (task.rev ?? 0) >= (previous.rev ?? 0)) merged.set(task.id, task);
        }
      }

      logger.debug('活跃任务拉取汇总', {
        statuses: statuses.length, pages, items: merged.size,
        stoppedBy: stops.length ? stops.join(',') : 'exhausted',
      });
      return {
        items: [...merged.values()],
        total: total || null,
        pages,
        stoppedBy: stops.length ? stops.join(',') : 'exhausted',
      };
    },

    async fetchProjects(force = false) {
      const now = Date.now();
      if (!force && projectCache.length && now - projectCacheAt < PROJECT_CACHE_MS) {
        logger.debug('项目列表命中缓存', {
          items: projectCache.length, ageMs: now - projectCacheAt,
        });
        return projectCache;
      }
      const response = await get('/v1/projects', { limit: PAGE_SIZE });
      projectCache = pickArray(response.json, 'projects') as MindwtrProject[];
      projectCacheAt = now;
      logger.debug('项目列表已刷新', { items: projectCache.length });
      return projectCache;
    },

    async health() {
      try {
        const response = await get('/health');
        const body = response.json as { ok?: boolean } | null;
        return Boolean(body?.ok);
      } catch {
        return false;
      }
    },

    recordSuccess() {
      const recovered = hadFailure;
      consecutiveFailures = 0;
      hadFailure = false;
      lastErrorMessage = '';
      if (recovered) logger.info('Cloud 连接已恢复');
      return { failures: 0, recovered };
    },

    recordFailure(message = '') {
      consecutiveFailures += 1;
      hadFailure = true;
      lastErrorMessage = summarizeError(message);
      logger.warn('Cloud 请求连续失败', {
        failures: consecutiveFailures, reason: lastErrorMessage,
      });
      return { failures: consecutiveFailures };
    },

    nextDelayMs() {
      if (consecutiveFailures === 0) return config.pollIntervalSeconds * 1000;
      // 指数退避：60s → 2min → 4min → 8min，上限由配置控制（默认 10 分钟）。
      const base = config.pollIntervalSeconds * 1000;
      const backoff = base * (2 ** Math.min(consecutiveFailures, 6));
      const delay = Math.min(backoff, config.enhancements.reliability.maxBackoffMs);
      logger.debug('退避间隔计算', { failures: consecutiveFailures, delayMs: delay });
      return delay;
    },

    lastError() {
      return lastErrorMessage;
    },
  };
}

/** 把异常转成可安全展示的一句话；实现统一收敛到 errors.ts（含空串兜底）。 */
export function summarizeError(error: unknown): string {
  return describeError(error);
}
