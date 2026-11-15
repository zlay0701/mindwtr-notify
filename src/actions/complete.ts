/**
 * 双向完成（M3 · EXT-19【官方无】，可选能力）
 *
 * ============================ 只读边界 ============================
 * 用户明确要求：对 Mindwtr Cloud 实例「只能查询，不能更改里面的数据」。
 * 因此本模块默认**不会发出任何写请求**：
 *   1. 必须同时打开 NOTIFY_ALLOW_WRITE=true 与 NOTIFY_COMPLETE_ACTION=true；
 *   2. CLI、Scheduler、Dispatcher 均不调用本函数，没有任何自动写路径；
 *   3. 默认配置下 completeTask() 在构造 URL 之前就返回拒绝，不发网络请求。
 *
 * 启用前的冲突评审（spec §13 要求的记录）：
 *   - POST /v1/tasks/:id/complete 会推进同步修订元数据、抬高 rev，
 *     触发所有客户端重新同步，可能与用户正在编辑的任务产生冲突；
 *   - 官方文档只在 PATCH 上写明支持 If-Match 乐观锁，
 *     complete 端点是否支持未经文档确认，启用前必须对你的实例实测；
 *   - 一旦放开，本服务就不再满足 EXT-15【官方无】的「纯只读」边界，
 *     需要重新评估令牌权限与审计策略。
 * ==================================================================
 */

import type { NotifyConfig } from '../config.ts';

export interface CompleteResult {
  /** 是否真的发出了 HTTP 请求。只读模式下恒为 false。 */
  attempted: boolean;
  ok: boolean;
  reason: string;
  status?: number;
}

/** 两道开关同时打开才允许写。供健康检查与测试直接断言。 */
export function canWriteToCloud(config: NotifyConfig): boolean {
  return config.m3.actions.allowWrite && config.m3.actions.completeEnabled;
}

/**
 * 把任务标记为完成。
 *
 * 默认返回「只读模式拒绝」；只有显式打开两道开关后才会构造 POST 请求。
 * @param options.ifMatch 可选 ETag。注意该端点是否支持 If-Match 未经验证，默认不传。
 */
export async function completeTask(
  config: NotifyConfig,
  taskId: string,
  options: { fetchImpl?: typeof fetch; ifMatch?: string } = {},
): Promise<CompleteResult> {
  if (!canWriteToCloud(config)) {
    return {
      attempted: false,
      ok: false,
      reason: '只读模式：需同时开启 NOTIFY_ALLOW_WRITE 与 NOTIFY_COMPLETE_ACTION，并完成冲突评审',
    };
  }

  const url = new URL(`${config.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/complete`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers,
      body: '{}',
    });
    return {
      attempted: true,
      ok: response.ok,
      reason: response.ok ? '已完成' : `服务端返回 ${response.status}`,
      status: response.status,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
