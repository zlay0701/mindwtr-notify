#!/usr/bin/env python3
# 文件职责：目标 D「VPS 部署联调」执行器。
#   独立项目名 notify-test、独立目录 /data/home/notify-test/app、端口 127.0.0.1:8789:8788、
#   独立命名卷、单副本；起服务 → healthz 探活 → 真实投递一轮 → 重启验证不重复投递 → 清理。
#
# 安全约束（改动本文件时不要削弱）：
#   1. MINDWTR_TOKEN / SMTP_PASS 只在内存中从本地 .env 读出，经 SFTP 直接写远端文件，
#      绝不打印、绝不出现在命令行参数、日志、报告或任何产出物里。
#   2. SSH_URI 是本机运维连接串，与 Notify 服务无关，上传时明确过滤掉，不进容器。
#   3. 把项目根目录 .dockerignore 同步到远端部署目录（排除 .env / scripts / data），
#      避免构建上下文带上凭据或能写云端的造数脚本；规则以本地文件为单一事实来源。
#   4. 校验 compose 只用 `docker compose config --quiet`；绝不使用会打印 env_file 明文的
#      `docker compose config`（已在 Compose v5.7.1 上实测会展开成明文）。
#   5. 远端命令回显统一经过 remote.py 的脱敏过滤；不触碰 VPS 上任何已有容器。
#
# 依赖：本机 Python 3 + paramiko，复用 scripts/remote.py 的连接与脱敏逻辑。
# 用法：python scripts/deploy-test.py prepare | up | verify | down | status

import argparse
import sys
from pathlib import Path

import paramiko

from remote import (
    REMOTE_APP_DIR,
    collect_secrets,
    command_sync,
    load_env,
    open_connection,
    run_remote,
)

PROJECT = 'notify-test'
HEALTHZ_PORT = 8789

# 覆盖文件只改容器名、宿主端口与渠道开关，其余保持项目 compose.yaml 原样。
# !override 是替换 ports 而不是追加，避免 8788 和 8789 同时映射。
#
# 为什么临时关掉 SMTP：实测该 VPS 出站到 smtp.resend.com 的 587 / 465 都被
# ECONNREFUSED（宿主机直连同样如此），属 VPS 网络策略，不是产品代码问题。
# .env 里的 SMTP 凭据仍完整注入容器；本轮改用同一 compose 网络内的本地
# Webhook 接收端完成「真实投递 → 重启不重复投递」的验证。
# 目标 B 已在本机用真实 SMTP 完整验证过邮件实发，两条链路互补。
OVERRIDE_YAML = '''# 目标 D 联调专用覆盖：与 VPS 上现有服务完全隔离
services:
  mindwtr-notify:
    container_name: notify-test-app
    ports: !override
      - "127.0.0.1:8789:8788"
    environment:
      SMTP_ENABLED: "false"
      WEBHOOK_ENABLED: "true"
      WEBHOOK_URLS: http://hook-receiver:18080/hook
      WEBHOOK_SECRET: notify-d-local-secret
      WEBHOOK_MAX_ATTEMPTS: "3"
  hook-receiver:
    image: oven/bun:1.3-alpine
    volumes:
      - ./hook-receiver.mjs:/app/hook.mjs:ro
    command: ["bun", "run", "/app/hook.mjs"]
    restart: unless-stopped
'''

# 本地 Webhook 接收端（不是产品代码）：只在 compose 内部网络监听，
# 用独立实现校验 HMAC，把每次请求记到容器日志，供联调核对投递次数。
HOOK_RECEIVER_JS = '''/**
 * 目标 D 联调用的本地 Webhook 接收端，不参与产品运行。
 * 独立实现 HMAC 校验，避免「用被测代码验证被测代码」。
 */
import { createHmac } from 'node:crypto';

const SECRET = 'notify-d-local-secret';
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 18080,
  async fetch(request) {
    const rawBody = await request.text();
    const timestamp = Number(request.headers.get('x-notify-timestamp') || 0);
    const signature = request.headers.get('x-notify-signature') || '';
    const expected = 'sha256=' + createHmac('sha256', SECRET)
      .update(`${timestamp}.${rawBody}`).digest('hex');
    const fresh = Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 300;
    console.log(`HOOK sig_ok=${signature === expected} fresh=${fresh} bytes=${Buffer.byteLength(rawBody)}`);
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  },
});
console.log(`HOOK_READY port=${server.port}`);
'''

def dockerignore_text():
    """读取项目根目录 .dockerignore 的内容，供远端构建上下文使用。

    参数：无。
    返回：str，文件内容。
    说明：排除规则只维护一份（项目根目录），避免远端副本和本地规则逐渐漂移；
          Dockerfile 已不 COPY scripts，且该文件排除了 .env 与 scripts/，
          所以凭据和能写测试实例的造数脚本都不会进构建上下文。
    """
    path = Path(__file__).resolve().parent.parent / '.dockerignore'
    return path.read_text(encoding='utf-8')


def write_remote_text(transport, path, text, mode=0o644):
    """把一段文本经 SFTP 写入远端文件并设置权限。

    参数：transport —— 已认证传输层；path —— 远端绝对路径；
          text —— 文件内容；mode —— Unix 权限位。
    返回：无。
    说明：用于上传凭据与配置，调用方负责保证内容不进入任何日志。
    """
    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        with sftp.file(path, 'w') as handle:
            handle.write(text)
        sftp.chmod(path, mode)
    finally:
        sftp.close()


def upload_deploy_env(transport):
    """上传部署用 .env：保留服务需要的键，过滤掉本机运维专用的 SSH_URI。

    参数：transport —— 已认证传输层。
    返回：无（只打印行数，不打印任何值）。
    """
    local = Path(__file__).resolve().parent.parent / '.env'
    kept = []
    for line in local.read_text(encoding='utf-8').splitlines():
        key = line.split('=', 1)[0].strip() if '=' in line else ''
        if key == 'SSH_URI':
            continue
        kept.append(line)
    # 末尾补换行，避免最后一行没有换行导致某些解析器漏读
    payload = '\n'.join(kept) + '\n'
    write_remote_text(transport, REMOTE_APP_DIR + '/.env', payload, 0o600)
    print(f'已上传部署配置：{len(kept)} 行，已过滤 SSH_URI，远端权限 600。')


def compose(transport, secrets, args, timeout=300):
    """在远端部署目录执行一条 docker compose 命令并打印脱敏后的结果。

    参数：transport / secrets —— 连接与脱敏串；args —— compose 子命令字符串；
          timeout —— 读超时秒数。
    返回：远端退出码。
    """
    # pipefail 保证「docker compose ... | tail」时仍能拿到 compose 的真实退出码
    command = f'set -o pipefail; cd {REMOTE_APP_DIR} && docker compose -p {PROJECT} {args}'
    code, out, err = run_remote(transport, command, secrets, timeout=timeout)
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print('--- 远端 stderr ---')
        print(err.rstrip()[:2000])
    print(f'远端退出码：{code}')
    return code


def command_prepare(transport, secrets):
    """prepare：同步源码、上传配置、写隔离覆盖、静态校验 compose。

    参数：transport / secrets —— 连接与脱敏串。
    返回：int 退出码。
    """
    print('--- 1/4 重新同步源码（含生产化后的 Dockerfile / compose.yaml / .dockerignore）---')
    sync_code = command_sync(transport, secrets)
    if sync_code != 0:
        print('源码同步失败，停止后续步骤。')
        return sync_code

    print('--- 2/4 上传部署配置与隔离覆盖 ---')
    upload_deploy_env(transport)
    write_remote_text(transport, REMOTE_APP_DIR + '/compose.override.yaml', OVERRIDE_YAML)
    write_remote_text(transport, REMOTE_APP_DIR + '/.dockerignore', dockerignore_text())
    write_remote_text(transport, REMOTE_APP_DIR + '/hook-receiver.mjs', HOOK_RECEIVER_JS)
    # 只列键名，绝不回显文件内容
    code, out, _ = run_remote(
        transport,
        f'cd {REMOTE_APP_DIR} && echo "ENV_KEYS:" && '
        "grep -o '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d '=' | sort && "
        'echo "ENV_MODE=$(stat -c %a .env)" && '
        'echo "OVERRIDE_OK=$(test -f compose.override.yaml && echo yes)" && '
        'echo "DOCKERIGNORE_OK=$(test -f .dockerignore && echo yes)" && '
        'echo "HOOK_RECEIVER_OK=$(test -f hook-receiver.mjs && echo yes)"',
        secrets,
    )
    print(out.rstrip())

    print('--- 3/4 compose 静态校验（--quiet，不打印配置内容）---')
    quiet = compose(transport, secrets, 'config --quiet', timeout=90)
    if quiet == 0:
        print('配置校验通过（未输出任何配置内容）。')

    print('--- 4/4 远端直连测试 Cloud 实例 ---')
    code, out, _ = run_remote(
        transport,
        'curl -sS -m 10 -o /dev/null -w "CLOUD_HEALTH=%{http_code}\\n" '
        'https://mindwtr-cloud.zlay.cc.cd/health',
        secrets,
    )
    print(out.rstrip())
    return quiet


def command_up(transport, secrets):
    """up：构建并起单副本常驻服务，随后探活 healthz 与检查卷。

    参数：transport / secrets —— 连接与脱敏串。
    返回：int 退出码。
    """
    code = compose(transport, secrets, 'up -d --build 2>&1 | tail -30', timeout=600)
    if code != 0:
        return code

    # 常驻服务启动后会立刻跑第一轮，给几秒让 /healthz 与状态库就绪。
    probe = (
        'sleep 4; '
        f'echo "HEALTHZ_HTTP=$(curl -sS -m 10 -o /dev/null -w %{{http_code}} http://127.0.0.1:{HEALTHZ_PORT}/healthz)"; '
        f'echo "HEALTHZ_BODY=$(curl -sS -m 10 http://127.0.0.1:{HEALTHZ_PORT}/healthz)"; '
        f'echo "ADMIN_HTTP=$(curl -sS -m 10 -o /dev/null -w %{{http_code}} http://127.0.0.1:{HEALTHZ_PORT}/admin)"; '
        f'echo "CONTAINERS=$(docker compose -p {PROJECT} ps --format \'{{{{.Name}}}} {{{{.Status}}}}\')" 2>/dev/null || true; '
        f'docker compose -p {PROJECT} ps; '
        'echo "PROJECT_VOLUMES:"; docker volume ls --format "{{.Name}}" | grep notify-test || true; '
        f'echo "--- LOGS ---"; docker compose -p {PROJECT} logs --tail 15 mindwtr-notify 2>&1 | tail -20'
    )
    c2, out, err = run_remote(transport, probe, secrets, timeout=180)
    print(out.rstrip())
    if err.strip():
        print('--- stderr ---\n' + err.rstrip()[:800])
    return c2


def sent_log_counts(transport, secrets):
    """读取容器内状态库的各状态计数，用于验证跨重启持久化。

    参数：transport / secrets —— 连接与脱敏串。
    返回：str，状态计数的原文（脱敏后）。
    """
    query = (
        "import { Database } from 'bun:sqlite'; "
        "const db = new Database(process.env.NOTIFY_STATE_PATH); "
        "console.log('SENT_LOG=' + JSON.stringify(db.query('SELECT status, COUNT(*) n FROM sent_log GROUP BY status').all()));"
    )
    code, out, err = run_remote(
        transport,
        f'cd {REMOTE_APP_DIR} && docker compose -p {PROJECT} exec -T mindwtr-notify bun -e "{query}"',
        secrets,
        timeout=90,
    )
    return (out + err).strip()


def command_verify(transport, secrets):
    """verify：造数 → 重启投递 → 再重启验证不重复投递。

    参数：transport / secrets —— 连接与脱敏串。
    返回：int 退出码。
    说明：造数脚本读的是部署目录里的 .env 文件，所以在远端宿主机用 node 跑，
          不进容器；服务常驻，靠 restart 触发「立即跑一轮」，也顺带验证重启。
    """
    print('--- 准备：重建联调环境（仅删本项目测试卷，让状态库从零开始）---')
    compose(transport, secrets, 'down -v 2>&1 | tail -8', timeout=180)
    compose(transport, secrets, 'up -d 2>&1 | tail -12', timeout=300)
    c0, out, _ = run_remote(
        transport,
        'sleep 5; '
        f'echo "HEALTHZ=$(curl -sS -m 10 -o /dev/null -w %{{http_code}} http://127.0.0.1:{HEALTHZ_PORT}/healthz)"; '
        f'docker compose -p {PROJECT} logs --tail 5 hook-receiver 2>&1 | tail -6',
        secrets,
        timeout=90,
    )
    print(out.rstrip())

    print('--- 1/5 刷新测试实例造数（相对当前时刻，产生 1 个到点触发点）---')
    seed = (
        f'set -o pipefail; cd {REMOTE_APP_DIR} && '
        'node scripts/seed-test-data.mjs 2>&1 | tail -12'
    )
    c1, out, err = run_remote(transport, seed, secrets, timeout=180)
    print(out.rstrip())
    if err.strip():
        print('--- stderr ---\n' + err.rstrip()[:800])
    if c1 != 0:
        return c1

    print('--- 2/5 第一次重启：服务立即跑一轮，真实投递 ---')
    c2 = compose(transport, secrets, 'restart mindwtr-notify 2>&1 | tail -5', timeout=180)
    if c2 != 0:
        return c2
    c3, out, _ = run_remote(
        transport,
        f'sleep 10; cd {REMOTE_APP_DIR} && '
        f'echo "--- NOTIFY LOGS ---"; docker compose -p {PROJECT} logs --tail 12 mindwtr-notify 2>&1 | tail -15; '
        f'echo "--- HOOK LOGS ---"; docker compose -p {PROJECT} logs hook-receiver 2>&1 | tail -8; '
        f'echo "HOOK_HITS=$(docker compose -p {PROJECT} logs hook-receiver 2>&1 | grep -c \'HOOK sig_ok\')"',
        secrets,
        timeout=90,
    )
    print(out.rstrip())
    counts_after_first = sent_log_counts(transport, secrets)
    print(counts_after_first)

    print('--- 3/5 第二次重启：状态库应跨重启保留，且不再投递 ---')
    c4 = compose(transport, secrets, 'restart mindwtr-notify 2>&1 | tail -5', timeout=180)
    if c4 != 0:
        return c4
    c5, out, _ = run_remote(
        transport,
        f'sleep 10; cd {REMOTE_APP_DIR} && '
        f'echo "--- NOTIFY LOGS ---"; docker compose -p {PROJECT} logs --tail 12 mindwtr-notify 2>&1 | tail -15; '
        f'echo "--- HOOK LOGS ---"; docker compose -p {PROJECT} logs hook-receiver 2>&1 | tail -8; '
        f'echo "HOOK_HITS=$(docker compose -p {PROJECT} logs hook-receiver 2>&1 | grep -c \'HOOK sig_ok\')"',
        secrets,
        timeout=90,
    )
    print(out.rstrip())
    counts_after_second = sent_log_counts(transport, secrets)
    print(counts_after_second)

    print('--- 4/5 healthz 复探（重启后仍可用）---')
    c6, out, _ = run_remote(
        transport,
        f'echo "HEALTHZ_HTTP=$(curl -sS -m 10 -o /dev/null -w %{{http_code}} http://127.0.0.1:{HEALTHZ_PORT}/healthz)"; '
        f'echo "HEALTHZ_BODY=$(curl -sS -m 10 http://127.0.0.1:{HEALTHZ_PORT}/healthz)"',
        secrets,
        timeout=60,
    )
    print(out.rstrip())

    print('--- 5/5 卷与容器最终状态 ---')
    c7, out, _ = run_remote(
        transport,
        f'docker compose -p {PROJECT} ps; '
        'docker volume ls --format "{{.Name}}" | grep notify-test || true; '
        f'echo "MOUNTS=$(docker inspect notify-test-app --format \'{{{{range .Mounts}}}}{{{{.Name}}}} {{{{.Destination}}}} {{{{end}}}}\')"',
        secrets,
        timeout=90,
    )
    print(out.rstrip())
    return 0 if all(c == 0 for c in (c3, c5, c6, c7)) else 1


def command_down(transport, secrets):
    """down：停掉联调容器，避免持续轮询与发信；命名卷保留以便复查。

    参数：transport / secrets —— 连接与脱敏串。
    返回：int 退出码。
    """
    code = compose(transport, secrets, 'down 2>&1 | tail -15', timeout=180)
    _, out, _ = run_remote(
        transport,
        'echo "REMAINING_NOTIFY_CONTAINERS:"; '
        '(docker ps -a --format "{{.Names}}" | grep notify-test || echo NONE); '
        'echo "KEPT_VOLUMES:"; (docker volume ls --format "{{.Name}}" | grep notify-test || echo NONE)',
        secrets,
    )
    print(out.rstrip())
    return code


def command_status(transport, secrets):
    """status：只读查看联调容器、卷与最近日志，不修改任何东西。

    参数：transport / secrets —— 连接与脱敏串。
    返回：int 退出码。
    """
    code, out, err = run_remote(
        transport,
        f'cd {REMOTE_APP_DIR} && docker compose -p {PROJECT} ps; '
        'echo "VOLUMES:"; docker volume ls --format "{{.Name}}" | grep notify-test || true; '
        f'echo "LOGS:"; docker compose -p {PROJECT} logs --tail 12 mindwtr-notify 2>&1 | tail -15',
        secrets,
        timeout=90,
    )
    print(out.rstrip())
    if err.strip():
        print('--- stderr ---\n' + err.rstrip()[:800])
    return code


def main():
    """解析子命令并分派，返回进程退出码。"""
    parser = argparse.ArgumentParser(description='Notify 目标 D 部署联调助手')
    parser.add_argument(
        'command',
        choices=('prepare', 'up', 'verify', 'down', 'status'),
        help='prepare=同步+上传配置+校验，up=起服务探活，verify=投递与重启去重，down=清理，status=只读查看',
    )
    args = parser.parse_args()

    env = load_env()
    secrets = collect_secrets(env)
    transport, sock = open_connection(env)
    try:
        handlers = {
            'prepare': command_prepare,
            'up': command_up,
            'verify': command_verify,
            'down': command_down,
            'status': command_status,
        }
        return handlers[args.command](transport, secrets)
    finally:
        transport.close()
        sock.close()


if __name__ == '__main__':
    sys.exit(main())
