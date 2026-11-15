/**
 * 状态存储：SQLite 持久化去重与投递审计
 * （EXT-06【增强】、EXT-07【增强】；M4 查询与命名空间隔离属 EXT-19【官方无】）
 *
 * 为什么不用官方那种进程内 Map：服务端会重启、会挂卷、要跨重启幂等，
 * 还要按渠道分别记录成败——邮件成功不能让失败的 Webhook 失去重试机会。
 * 因此唯一键是 (触发点, channel)，对应 spec 的 sent_log 设计。
 *
 * M4 多命名空间隔离（EXT-19【官方无】）分三层，任何一层单独生效都不会串数据：
 *   1. 物理：状态库路径按 namespace 派生出不同文件（见 state/namespace.ts）；
 *   2. 逻辑：sent_log 有 namespace 列，所有读写都带 namespace 过滤；
 *   3. 键：非默认命名空间的去重键 / meta 键加 `ns=<ns>:` 前缀。
 * 默认命名空间 `default` 不加前缀，旧数据库记录原样可用；旧表缺列时自动补列并
 * 把历史记录归入 `default`，整个迁移不改动任何业务数据、不产生触发点。
 *
 * 运行时适配：Bun 用 bun:sqlite，Node 22+ 用 node:sqlite（目前是实验特性）。
 * 两者语句对象都提供 run/get/all，只有「编译 SQL」的方法名不同（query / prepare）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_NAMESPACE, namespacedKey, normalizeNamespace, unscopeKey,
} from './namespace.ts';

type Statement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

type Database = {
  exec(sql: string): void;
  prepare?(sql: string): Statement;
  query?(sql: string): Statement;
  close(): void;
};

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped_late';

/** 写一条待发记录时需要的元信息。 */
export interface DeliveryMeta {
  taskId: string;
  triggerType: string;
  triggerAt: number;
  channel: string;
}

/** 管理页「已发记录 / 失败记录」的一行。dedupeKey 已去掉命名空间前缀，方便阅读。 */
export interface SentRecord {
  dedupeKey: string;
  taskId: string;
  triggerType: string;
  triggerAt: number;
  channel: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 管理页「审计日志」的一行。刻意不记 token、Webhook URL 或任务正文。 */
export interface AuditRecord {
  id: number;
  at: number;
  action: string;
  actor: string;
  detail: string;
  ok: boolean;
}

export interface StateStore {
  /** 该触发点在该渠道是否已经处理过（pending/sent 都算，避免重复投递）。 */
  hasSent(dedupeKey: string): boolean;
  markPending(dedupeKey: string, meta: DeliveryMeta): void;
  markSent(dedupeKey: string): void;
  markFailed(dedupeKey: string, error: string): void;
  markSkippedLate(dedupeKey: string): void;
  pendingCount(): number;
  /** healthz 用：每个渠道最近一次投递结果，不含任务内容。 */
  channelStatus(): Record<string, { status: string; at: number }>;
  /** backlog 节流用：读写简单的键值元数据。 */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // ---- 以下 M4 方法全部属于 EXT-19【官方无】：只做本地状态查询 / 重置，不产生触发点 ----

  /** M4 · EXT-19【官方无】：各状态记录数（只读，按 namespace 过滤）。 */
  recordCounts(): Record<DeliveryStatus, number>;
  /** M4 · EXT-19【官方无】：按状态查投递记录，按更新时间倒序。 */
  listRecords(options?: { statuses?: DeliveryStatus[]; limit?: number }): SentRecord[];
  /**
   * M4 · EXT-19【官方无】手动重发：把一条记录重置为「可重试」。
   * 只改本地状态、不改触发计划；下一轮仍由 BASE-27【一致】补发窗口决定是否真的发。
   * @returns 记录存在并已重置返回 true；键不存在返回 false
   */
  requestRetry(dedupeKey: string): boolean;
  /** M4 · EXT-19【官方无】审计：记一条管理操作（成功或拒绝），不记录任何凭据原文。 */
  addAudit(entry: { action: string; actor: string; detail: string; ok: boolean }): void;
  /** M4 · EXT-19【官方无】审计：按 namespace 读最近若干条。 */
  listAudit(limit?: number): AuditRecord[];
  close(): void;
}

/** 打开数据库，按运行时选择驱动。 */
async function openDatabase(path: string): Promise<{ db: Database; compile: (sql: string) => Statement }> {
  mkdirSync(dirname(path), { recursive: true });

  // Bun 环境优先（生产镜像）。Node 下 import('bun:sqlite') 会失败，直接落到下一个分支。
  try {
    const bunSqlite = await import('bun:sqlite') as unknown as {
      Database: new (file: string) => Database;
    };
    const db = new bunSqlite.Database(path);
    return { db, compile: (sql: string) => db.query!(sql) };
  } catch {
    // 不是 Bun，继续尝试 Node 内置 SQLite。
  }

  try {
    const nodeSqlite = await import('node:sqlite') as unknown as {
      DatabaseSync: new (file: string) => Database;
    };
    const db = new nodeSqlite.DatabaseSync(path);
    return { db, compile: (sql: string) => db.prepare!(sql) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法打开 SQLite（需要 Bun 或 Node 22+）：${reason}`);
  }
}

/**
 * 兼容 M1–M3 的旧数据库：旧 sent_log 没有 namespace 列。
 * 补列时给常量默认值 'default'，SQLite 会把全部历史记录归入默认命名空间，
 * 因此升级 M4 不会导致历史触发点被重新投递（BASE-29 去重语义保持）。
 */
function ensureNamespaceColumn(db: Database, compile: (sql: string) => Statement): void {
  try {
    const columns = compile('PRAGMA table_info(sent_log)').all()
      .map(row => String(row.name));
    if (columns.includes('namespace')) return;
  } catch {
    // 个别驱动不允许用 prepare/query 编译 PRAGMA，退回到直接尝试 ALTER。
  }
  try {
    db.exec("ALTER TABLE sent_log ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';");
  } catch {
    // 列已经存在（新表或已迁移过），忽略即可。
  }
}

/**
 * 创建状态库。
 * @param path      数据库文件路径，父目录会自动创建
 * @param namespace 命名空间；默认 `default`，与 M1–M3 行为完全一致
 */
export async function createStateStore(
  path: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<StateStore> {
  const ns = normalizeNamespace(namespace);
  const { db, compile } = await openDatabase(path);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sent_log (
      dedupe_key   TEXT PRIMARY KEY,
      namespace    TEXT NOT NULL,
      task_id      TEXT,
      trigger_type TEXT NOT NULL,
      trigger_at   INTEGER NOT NULL,
      channel      TEXT NOT NULL,
      status       TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sent_log_status ON sent_log(status);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      at        INTEGER NOT NULL,
      action    TEXT NOT NULL,
      actor     TEXT NOT NULL,
      detail    TEXT NOT NULL,
      ok        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_namespace ON audit_log(namespace, at);
  `);
  ensureNamespaceColumn(db, compile);
  // 索引依赖 namespace 列，必须等旧表补列之后再建，否则旧库会报 "no such column"。
  db.exec('CREATE INDEX IF NOT EXISTS idx_sent_log_namespace ON sent_log(namespace, updated_at);');

  const insertPending = compile(`
    INSERT OR IGNORE INTO sent_log
      (dedupe_key, namespace, task_id, trigger_type, trigger_at, channel, status,
       attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const updateStatus = compile(`
    UPDATE sent_log SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
    WHERE dedupe_key = ? AND namespace = ?
  `);
  const selectOne = compile('SELECT status FROM sent_log WHERE dedupe_key = ? AND namespace = ?');
  const countPending = compile(
    "SELECT COUNT(*) AS n FROM sent_log WHERE namespace = ? AND status IN ('pending', 'failed')",
  );
  const selectChannels = compile(`
    SELECT channel, status, updated_at FROM sent_log
    WHERE namespace = ? AND (channel, updated_at) IN (
      SELECT channel, MAX(updated_at) FROM sent_log WHERE namespace = ? GROUP BY channel
    )
  `);
  const countByStatus = compile(
    'SELECT status, COUNT(*) AS n FROM sent_log WHERE namespace = ? GROUP BY status',
  );
  const selectMeta = compile('SELECT value FROM meta WHERE key = ?');
  const upsertMeta = compile(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const resetForRetry = compile(`
    UPDATE sent_log SET status = 'failed', last_error = NULL, updated_at = ?
    WHERE dedupe_key = ? AND namespace = ?
  `);
  const selectForRetry = compile(
    'SELECT 1 AS ok FROM sent_log WHERE dedupe_key = ? AND namespace = ?',
  );
  const insertAudit = compile(`
    INSERT INTO audit_log (namespace, at, action, actor, detail, ok)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  /** 把数据库行转成管理页用的结构；对外隐藏命名空间前缀。 */
  function toSentRecord(row: Record<string, unknown>): SentRecord {
    return {
      dedupeKey: unscopeKey(ns, String(row.dedupe_key)),
      taskId: String(row.task_id ?? ''),
      triggerType: String(row.trigger_type),
      triggerAt: Number(row.trigger_at),
      channel: String(row.channel),
      status: String(row.status) as DeliveryStatus,
      attempts: Number(row.attempts),
      lastError: row.last_error === null || row.last_error === undefined
        ? null : String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** 所有外部键进入 SQL 前统一加前缀，业务代码完全不需要感知 namespace。 */
  const scope = (key: string) => namespacedKey(ns, key);

  return {
    hasSent(dedupeKey) {
      const row = selectOne.get(scope(dedupeKey), ns);
      // pending 也要算「已处理」：上一轮已开始投递，不能因重启再发一遍。
      return row?.status === 'sent' || row?.status === 'pending' || row?.status === 'skipped_late';
    },

    markPending(dedupeKey, meta) {
      const now = Date.now();
      insertPending.run(
        scope(dedupeKey), ns, meta.taskId, meta.triggerType, meta.triggerAt, meta.channel, now, now,
      );
    },

    markSent(dedupeKey) {
      updateStatus.run('sent', null, Date.now(), scope(dedupeKey), ns);
    },

    markFailed(dedupeKey, error) {
      // 失败后保留记录但状态为 failed，下一轮可重试（hasSent 不把 failed 当已完成）。
      updateStatus.run('failed', error.slice(0, 300), Date.now(), scope(dedupeKey), ns);
    },

    markSkippedLate(dedupeKey) {
      updateStatus.run('skipped_late', '超过补发窗口', Date.now(), scope(dedupeKey), ns);
    },

    pendingCount() {
      const row = countPending.get(ns);
      return Number(row?.n ?? 0);
    },

    channelStatus() {
      const result: Record<string, { status: string; at: number }> = {};
      for (const row of selectChannels.all(ns, ns)) {
        result[String(row.channel)] = {
          status: String(row.status),
          at: Number(row.updated_at),
        };
      }
      return result;
    },

    getMeta(key) {
      const row = selectMeta.get(scope(key));
      return row ? String(row.value) : null;
    },

    setMeta(key, value) {
      upsertMeta.run(scope(key), value);
    },

    recordCounts() {
      const counts: Record<DeliveryStatus, number> = {
        pending: 0, sent: 0, failed: 0, skipped_late: 0,
      };
      for (const row of countByStatus.all(ns)) {
        const status = String(row.status) as DeliveryStatus;
        if (status in counts) counts[status] = Number(row.n);
      }
      return counts;
    },

    listRecords(options = {}) {
      const statuses = options.statuses ?? ['sent'];
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      if (!statuses.length) return [];

      // 占位符数量由调用方给的状态数组决定；值全部走参数绑定，不拼进 SQL。
      const placeholders = statuses.map(() => '?').join(',');
      const rows = compile(`
        SELECT dedupe_key, task_id, trigger_type, trigger_at, channel, status,
               attempts, last_error, created_at, updated_at
        FROM sent_log
        WHERE namespace = ? AND status IN (${placeholders})
        ORDER BY updated_at DESC LIMIT ?
      `).all(ns, ...statuses, limit);
      return rows.map(toSentRecord);
    },

    requestRetry(dedupeKey) {
      const key = scope(dedupeKey);
      // 先查存在性，不依赖不同 SQLite 驱动 run() 返回值格式的差异。
      if (!selectForRetry.get(key, ns)) return false;
      // 置为 failed 而不是删除：hasSent 不把 failed 当完成，下一轮会按原计划重投；
      // 记录留着便于审计，也不会让 BASE-27 的补发窗口被绕过。
      resetForRetry.run(Date.now(), key, ns);
      return true;
    },

    addAudit(entry) {
      insertAudit.run(
        ns, Date.now(), entry.action.slice(0, 60), entry.actor.slice(0, 60),
        entry.detail.slice(0, 300), entry.ok ? 1 : 0,
      );
    },

    listAudit(limit = 100) {
      const rows = compile(`
        SELECT id, at, action, actor, detail, ok FROM audit_log
        WHERE namespace = ? ORDER BY at DESC, id DESC LIMIT ?
      `).all(ns, Math.max(1, Math.min(limit, 500)));
      return rows.map(row => ({
        id: Number(row.id),
        at: Number(row.at),
        action: String(row.action),
        actor: String(row.actor),
        detail: String(row.detail),
        ok: Number(row.ok) === 1,
      }));
    },

    close() {
      db.close();
    },
  };
}
