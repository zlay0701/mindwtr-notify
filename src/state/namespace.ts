/**
 * 多命名空间工具（M4 · EXT-19 后半【官方无】）
 *
 * 「命名空间」让同一台机器可以并行跑多套 Notify 实例而互不串数据，隔离分三层：
 *   1. 配置：NOTIFY_NAMESPACE 选择当前实例，JSON 配置文件可用 namespaces.<ns> 分段覆盖；
 *   2. 状态库：默认路径按命名空间派生出不同文件（物理隔离）；
 *   3. 去重键：写 sent_log / meta 时加命名空间前缀（逻辑隔离）。
 *
 * 与 BASE 规则的关系（spec §18）：EXT-19【官方无】后半不改变任何触发点。
 * 默认命名空间 `default` 的键前缀为空，与 M1–M3 已落库的记录完全兼容；
 * 只有显式声明的命名空间才加前缀，因此 strict 计划集合保持 100% 一致。
 *
 * 为什么还要在键里加前缀：即使运维把两个命名空间误配到同一个 SQLite 文件，
 * 两个键也不会撞在一起；状态库查询额外带 namespace 列过滤，形成双保险。
 */

import { basename, dirname, extname, join } from 'node:path';

/** 未指定命名空间时的默认值，刻意与旧版本行为保持一致。 */
export const DEFAULT_NAMESPACE = 'default';

/** 非默认命名空间的键前缀。用 `ns=` 开头，便于人工看日志时一眼识别。 */
const KEY_PREFIX = 'ns=';

/**
 * 规范化命名空间名字（M4 · EXT-19【官方无】）。
 *
 * 为什么要清洗：命名空间会拼进状态库文件名，若允许 `/`、`..` 或盘符就会导致
 * 路径穿越；同时大小写差异容易让人误以为是两套实例。只保留小写字母、数字、
 * 连字符与下划线，并截断到 32 字符，避免生成超长文件名。
 *
 * @param value 原始配置值（可为空）
 * @returns 安全、稳定、可直接拼进路径的命名空间名；空值返回 `default`
 */
export function normalizeNamespace(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed) return DEFAULT_NAMESPACE;
  const safe = trimmed.replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  return safe || DEFAULT_NAMESPACE;
}

/**
 * 给内部键（去重键 / meta 键）加命名空间前缀（EXT-19【官方无】，BASE-29 语义不变）。
 *
 * `default` 不加前缀是刻意设计：旧数据库里的 sent_log 记录仍是裸键，
 * 不这么做会让 M4 升级后重复投递历史提醒。
 *
 * @param namespace 已规范化的命名空间
 * @param key       业务侧原始键，例如 `task-1:due:2026-11-13T09:00:00.000Z:email`
 * @returns 实际落库的键
 */
export function namespacedKey(namespace: string, key: string): string {
  return namespace === DEFAULT_NAMESPACE ? key : `${KEY_PREFIX}${namespace}:${key}`;
}

/**
 * 去掉命名空间前缀，供管理页展示原始去重键（M4 · EXT-19【官方无】）。
 * @param namespace 当前命名空间
 * @param storedKey 数据库里存的键
 * @returns 去掉前缀后的业务键；不匹配前缀时原样返回
 */
export function unscopeKey(namespace: string, storedKey: string): string {
  const prefix = `${KEY_PREFIX}${namespace}:`;
  return namespace !== DEFAULT_NAMESPACE && storedKey.startsWith(prefix)
    ? storedKey.slice(prefix.length)
    : storedKey;
}

/**
 * 按命名空间派生状态库文件路径（EXT-19【官方无】）。
 * 例：`data/notify.sqlite` + `work` → `data/notify-work.sqlite`。
 *
 * 只在未显式指定路径时由配置层调用；显式指定的路径同样会派生，
 * 这样 compose 里固定 `NOTIFY_STATE_PATH` 时多实例依然各自独立。
 *
 * @param basePath  基础路径（绝对路径）
 * @param namespace 已规范化的命名空间
 * @returns 派生后的路径；`default` 原样返回
 */
export function statePathForNamespace(basePath: string, namespace: string): string {
  if (namespace === DEFAULT_NAMESPACE) return basePath;
  const extension = extname(basePath);
  const stem = basename(basePath, extension);
  return join(dirname(basePath), `${stem}-${namespace}${extension}`);
}
