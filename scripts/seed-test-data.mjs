#!/usr/bin/env node
/**
 * 测试服务器造数脚本（仅用于测试实例，不参与 Notify 产品运行）
 *
 * ⚠️ 这是「对 Mindwtr Cloud 只读约束」的**显式例外**，边界必须说清楚：
 *   1. 产品代码 src/ 内仍严格只读 —— src/cloud/client.ts 的 GET 双白名单一个字都没改；
 *   2. 本脚本只在 MINDWTR_BASE_URL 指向**非生产**实例时才运行，启动时硬检查；
 *   3. 写操作只有四条固定路径：POST /v1/tasks、PATCH /v1/tasks/:id（任务造数），
 *      POST /v1/projects、PATCH /v1/projects/:id（项目造数，均只滚动自己造的数据）；
 *      不 DELETE 任何东西、不写文件、不输出 token 与任务/项目正文；
 *   4. 只读约束的完整记录见 spec.md §10 / §13，本脚本不改变那些结论。
 *
 * 目的：给空库补上带 dueDate / startTime / reviewAt 的任务，以及带 reviewAt 的项目，
 * 让 strict dry-run 能算出任务级触发点与项目回顾（BASE-07）触发点，
 * 从而验证 M1 规则引擎、BASE-22 仅日期判定与 M4 管理页「下一批待触发提醒」。
 *
 * 用法：node scripts/seed-test-data.mjs
 * 幂等：按标题前缀 [NotifyTest] 识别；已存在就 PATCH 把时间滚动到「相对当前」，
 *       不会重复创建，也不需要删除权限。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 生产实例地址。命中即拒绝执行，这是防止误写真实数据的最后一道闸。 */
const PRODUCTION_URL = 'https://mindwtr-cloud.zlay.dpdns.org';
/** 测试任务的标题前缀，便于识别和后续人工清理。 */
const TEST_PREFIX = '[NotifyTest]';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析，只认 KEY=VALUE；结果与产品 src/config.ts 保持一致。 */
function readDotEnv() {
  const result = {};
  const lines = readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const index = text.indexOf('=');
    if (index < 0) continue;
    result[text.slice(0, index).trim()] = text.slice(index + 1).trim()
      .replace(/^["']|["']$/g, '');
  }
  return result;
}

const env = readDotEnv();
const baseUrl = (env.MINDWTR_BASE_URL || '').replace(/\/+$/, '');
const token = env.MINDWTR_TOKEN || '';

// 护栏一：绝不允许打到生产实例；地址为空、含生产域名、非 http(s) 一律拒绝。
if (!baseUrl || baseUrl === PRODUCTION_URL || baseUrl.includes('zlay.dpdns.org')) {
  console.error('拒绝执行：MINDWTR_BASE_URL 为空或仍指向生产实例，请先切到测试服务器。');
  process.exit(1);
}
if (!/^https?:\/\//.test(baseUrl) || !token) {
  console.error('拒绝执行：地址不是合法 http(s) 或缺少 MINDWTR_TOKEN。');
  process.exit(1);
}

console.log(`目标实例：${baseUrl}（已确认非生产）`);

// 护栏二：所有请求路径都由本脚本硬编码拼出，不接受任何外部输入路径。
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/**
 * 统一请求封装。
 * @param method 只允许 GET / POST / PATCH
 * @param pathname 以 / 开头的固定路径
 * @param body 可选 JSON 请求体
 * @returns { status, json, text }，text 只用于失败时判断长度，绝不回显
 */
async function request(method, pathname, body) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应按空处理 */ }
  return { status: response.status, json, text };
}

/** 失败时只摘出 error 字符串，避免把响应正文（可能含任务内容）打进终端。 */
function briefError(response) {
  const error = response.json && typeof response.json.error === 'string'
    ? response.json.error : '';
  return error ? `原因：${error.slice(0, 160)}` : `响应 ${response.text.length} 字节`;
}

const now = Date.now();
/** 相对当前时刻的 UTC ISO 字符串，带 T 时间部分，符合 BASE-21 的「带时间」判定。 */
const isoAt = minutes => new Date(now + minutes * 60_000).toISOString();
/** 仅日期（不带时间），用于验证 BASE-22：不产生任何任务级触发点。 */
const dateKey = new Date(now).toISOString().slice(0, 10);

/**
 * 五条样本覆盖：未来截止、刚过补发窗口内的截止、未来开始、未来回顾、仅日期。
 * 时间全部相对「运行时刻」生成，所以重跑脚本后测试依然有效。
 */
const samples = [
  { title: `${TEST_PREFIX} 截止·未来10分钟`, fields: { status: 'next', dueDate: isoAt(10) } },
  { title: `${TEST_PREFIX} 截止·刚过2分钟`, fields: { status: 'next', dueDate: isoAt(-2) } },
  { title: `${TEST_PREFIX} 开始·未来30分钟`, fields: { status: 'next', startTime: isoAt(30) } },
  { title: `${TEST_PREFIX} 回顾·未来60分钟`, fields: { status: 'next', reviewAt: isoAt(60) } },
  { title: `${TEST_PREFIX} 仅日期·应不触发`, fields: { status: 'next', dueDate: dateKey } },
];

/**
 * 项目样本（BASE-07 项目回顾）：带 reviewAt 的项目才会产生 project-review 触发点。
 * 与任务一样按标题前缀幂等：已存在就 PATCH 把 reviewAt 滚到相对当前时刻。
 * status 用官方项目枚举 active（项目的状态是 active/someday/waiting/archived，不是任务的 next）。
 * 注意：只设 reviewAt、不动其它字段，避免碰既有项目数据。
 */
const projectSamples = [
  { title: `${TEST_PREFIX} 项目·回顾未来45分钟`, fields: { status: 'active', reviewAt: isoAt(45) } },
  { title: `${TEST_PREFIX} 项目·回顾刚过3分钟`, fields: { status: 'active', reviewAt: isoAt(-3) } },
];

/**
 * 新建项目：官方文档没给项目 body 示例，但项目与任务同用 cloudWrite 机制，
 * 且 `cancelledAt` 段落明确「创建时在 props 里接收字段」→ 先试 { title, props }；
 * 若服务端要求扁平字段（400），再退回 { title, ...fields }。只发两种固定结构，不输出正文。
 * @returns { status, json } 最终一次响应的状态与解析结果
 */
async function createProject(sample) {
  const shaped = await request('POST', '/v1/projects', {
    title: sample.title,
    props: sample.fields,
  });
  if (shaped.status >= 200 && shaped.status < 300) return shaped;
  // 用扁平字段再试一次；仍失败就返回第二次结果，由调用方按状态处理。
  if (shaped.status === 400) {
    return request('POST', '/v1/projects', { title: sample.title, ...sample.fields });
  }
  return shaped;
}

async function main() {
  // 先读现网数据，判断哪些测试任务已经存在（GET，纯只读）。
  const list = await request('GET', '/v1/tasks?all=1&limit=100');
  if (list.status !== 200) {
    console.error(`读取现有任务失败：HTTP ${list.status}（${briefError(list)}）`);
    process.exitCode = 1;
    return;
  }
  const existing = new Map();
  for (const task of list.json?.tasks ?? []) {
    if (typeof task.title === 'string' && task.title.startsWith(TEST_PREFIX)) {
      existing.set(task.title, task);
    }
  }
  console.log(`已有测试任务：${existing.size} 条`);

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const sample of samples) {
    const found = existing.get(sample.title);
    if (found) {
      // PATCH 用扁平字段（官方 Cloud API 示例），把时间滚动回相对当前的时刻。
      const patched = await request('PATCH', `/v1/tasks/${encodeURIComponent(found.id)}`, sample.fields);
      if (patched.status >= 200 && patched.status < 300) {
        updated += 1;
        console.log(`更新 ${sample.title} -> ${patched.status}`);
      } else {
        failed += 1;
        console.log(`更新失败 ${sample.title} -> ${patched.status} ${briefError(patched)}`);
      }
      continue;
    }

    // POST 创建用 { title, props } 结构；status 必须放在 props 里（官方文档要求）。
    const createdResponse = await request('POST', '/v1/tasks', {
      title: sample.title,
      props: sample.fields,
    });
    if (createdResponse.status >= 200 && createdResponse.status < 300) {
      created += 1;
      // 不同服务端版本可能直接返回 task，也可能包一层，两种都兼容。
      const task = createdResponse.json?.task ?? createdResponse.json;
      console.log(`新建 ${sample.title} -> ${createdResponse.status} id=${task?.id ?? '服务端未回显'}`);
    } else {
      failed += 1;
      console.log(`新建失败 ${sample.title} -> ${createdResponse.status} ${briefError(createdResponse)}`);
    }
  }

  // --- 项目造数（BASE-07 项目回顾）---
  const projectList = await request('GET', '/v1/projects?limit=100');
  if (projectList.status !== 200) {
    console.error(`读取现有项目失败：HTTP ${projectList.status}（${briefError(projectList)}）`);
    process.exitCode = 1;
    return;
  }
  const existingProjects = new Map();
  for (const project of projectList.json?.projects ?? []) {
    if (typeof project.title === 'string' && project.title.startsWith(TEST_PREFIX)) {
      existingProjects.set(project.title, project);
    }
  }
  console.log(`已有测试项目：${existingProjects.size} 条`);

  let projectsCreated = 0;
  let projectsUpdated = 0;
  let projectsFailed = 0;

  for (const sample of projectSamples) {
    const found = existingProjects.get(sample.title);
    if (found) {
      // PATCH 用扁平字段，把 reviewAt 滚回相对当前时刻。
      const patched = await request('PATCH', `/v1/projects/${encodeURIComponent(found.id)}`, sample.fields);
      if (patched.status >= 200 && patched.status < 300) {
        projectsUpdated += 1;
        console.log(`更新项目 ${sample.title} -> ${patched.status}`);
      } else {
        projectsFailed += 1;
        console.log(`更新项目失败 ${sample.title} -> ${patched.status} ${briefError(patched)}`);
      }
      continue;
    }

    const made = await createProject(sample);
    if (made.status >= 200 && made.status < 300) {
      projectsCreated += 1;
      const project = made.json?.project ?? made.json;
      console.log(`新建项目 ${sample.title} -> ${made.status} id=${project?.id ?? '服务端未回显'}`);
    } else {
      projectsFailed += 1;
      console.log(`新建项目失败 ${sample.title} -> ${made.status} ${briefError(made)}`);
    }
  }

  console.log(`完成：任务 新建 ${created} / 更新 ${updated}；项目 新建 ${projectsCreated} / 更新 ${projectsUpdated}；失败 ${failed + projectsFailed} 条。`);
  if (failed + projectsFailed) process.exitCode = 1;
}

void main();
