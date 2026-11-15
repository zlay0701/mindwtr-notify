/**
 * 本地 HTTP 服务：健康端点 + 可挂载的只读管理页路由
 *
 * /healthz —— EXT-12【官方无】：只返回运行指标，不含任务内容、Webhook URL 或任何凭据。
 * /admin/* —— M4 · EXT-19【官方无】：由外部注入的 AdminHandler 处理，本文件只做路由分派。
 * 两者共用同一个端口（compose 只映射回环），避免为管理页再开一个对外端口。
 *
 * 注意：这里的 HTTP 服务是「本地管理服务器」，与 Cloud API 完全无关；
 * 对 Mindwtr Cloud 的请求仍只走 src/cloud/client.ts 的 GET 双白名单。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describeError } from './errors.ts';
import { createLogger, type Logger } from './logger.ts';
import type { SchedulerStatus } from './scheduler.ts';

/** 管理页处理器契约。返回 true 表示请求已被处理，false 则由本文件回 404。 */
export interface AdminHandler {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

export interface HealthzHandle {
  /** 监听完成，测试里用 port() 取实际端口前先 await 它。 */
  ready: Promise<void>;
  /** 实际监听端口；port=0 时由系统分配。 */
  port(): number;
  close(): Promise<void>;
}

/** 恒定时间比较，避免用普通 === 泄漏 token 前缀信息。管理页复用同一个函数。 */
export function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

/**
 * 启动本地 HTTP 服务（/healthz 为 EXT-12【官方无】；/admin 委托为 M4 · EXT-19【官方无】）。
 * @param port    监听端口，0 表示由系统分配（单元测试用）
 * @param getStatus 返回 /healthz 的运行指标快照
 * @param token  非空时 /healthz 需要 Bearer 鉴权
 * @param admin  可选的管理页处理器，处理 /admin 前缀下的路由
 * @param logger EXT-20【官方无】分级日志器；不传时用 info 级别（单元测试路径）
 */
export function startHealthz(
  port: number,
  getStatus: () => SchedulerStatus,
  token = '',
  admin?: AdminHandler,
  logger: Logger = createLogger({ level: 'info' }),
): HealthzHandle {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // debug 只记路径，绝不记 url.search：/healthz 支持 ?token= 传参，
    // 把查询串写进日志等于把鉴权凭据落盘。
    logger.debug('本地 HTTP 请求', { path: url.pathname, method: request.method ?? '-' });

    if (url.pathname === '/healthz') {
      // 保持原有语义：/healthz 只接受 GET。
      if (request.method !== 'GET') {
        notFound(response);
        return;
      }
      if (token) {
        const header = request.headers.authorization ?? '';
        const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
        const fromQuery = url.searchParams.get('token') ?? '';
        if (!tokenMatches(fromHeader || fromQuery, token)) {
          response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Unauthorized');
          return;
        }
      }
      // 只取一次快照，避免同一次请求里前后字段来自不同时刻。
      const body = JSON.stringify(getStatus());
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (admin && url.pathname.startsWith('/admin')) {
      void admin.handle(request, response, url).then(handled => {
        if (!handled && !response.writableEnded) notFound(response);
      }).catch(error => {
        // 错误信息只写日志，不回显给浏览器，避免泄露内部路径或凭据。
        logger.error('管理页请求处理失败', { reason: describeError(error) });
        if (!response.writableEnded) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Internal error');
        }
      });
      return;
    }

    notFound(response);
  });

  let markReady: () => void = () => {};
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  server.listen(port, '0.0.0.0', () => markReady());

  return {
    ready,
    port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : port;
    },
    close() {
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
