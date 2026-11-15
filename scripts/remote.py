#!/usr/bin/env python3
# 文件职责：通过 SSH_URI 连接远程 Linux，为 Notify 提供源码同步、测试、镜像构建等运维能力。
#
# 安全约束（重要，改动本文件时不要削弱）：
#   1. SSH_URI 只从工作区根目录 .env 读取，绝不打印、绝不写进命令行参数、日志或任何产出物。
#   2. 远端 instabox 服务使用「用户名即一次性凭证 + none 认证」，
#      本脚本不读取 ~/.ssh 下任何私钥，也不需要密码。
#   3. 同步源码采用白名单，明确排除 .env、data/、.workbuddy/，
#      避免把 MINDWTR_TOKEN / SMTP_PASS 等凭据上传到远端。
#   4. 所有远端回显都经过脱敏过滤；起容器、发邮件等有外部副作用的动作不在本脚本内，
#      必须由调用方另外确认后执行。
#
# 依赖：本机 Python 3 + paramiko（仅运维使用，不影响产品代码「零运行时依赖」的约定）。
# 用法：python scripts/remote.py check | sync | test | build | smoke

import argparse
import os
import socket
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import paramiko

# 工作区根目录：scripts/ 的上一级
ROOT = Path(__file__).resolve().parent.parent

# 远端专用目录。VPS 上还跑着 Coolify、mindwtr-cloud 等生产容器，
# 单独建目录可以避免碰到任何已有项目。
REMOTE_DIR = '/data/home/notify-test'
REMOTE_APP_DIR = REMOTE_DIR + '/app'

# 构建出的镜像只打本地测试标签，不推仓库、不覆盖已有镜像
IMAGE_TAG = 'mindwtr-notify:remote-test'

# 远端是按需唤醒的临时 SSH 沙箱，建连阶段偶发不返回 banner。
# 只在「建立连接」这一步做有限重试，命令执行阶段不重试，避免重复执行有副作用的操作。
CONNECT_ATTEMPTS = 3
CONNECT_RETRY_DELAY = 3

# 上传白名单：只有这些文件会进 tar 包，.env / data / .workbuddy 一律不带。
# .dockerignore 必须一起同步：远端 docker build 的构建上下文排除规则要跟本机一致（目标 E）。
INCLUDE_ITEMS = (
    'package.json',
    'Dockerfile',
    'compose.yaml',
    '.dockerignore',
    '.env.example',
    'src',
    'scripts',
    'tests',
)

# 本机运维脚本不参与远端的测试与构建，同步时跳过；
# 构建上下文里整个 scripts/ 由 .dockerignore 排除，生产镜像因此不含造数 / 运维脚本。
EXCLUDE_RELATIVE_PATHS = {'scripts/remote.py'}
EXCLUDE_FILE_NAMES = {'.pyc', '.DS_Store'}

# 需要脱敏的键：这些值一旦出现在远端回显里会被替换成 <redacted>
SENSITIVE_ENV_KEYS = (
    'SSH_URI',
    'MINDWTR_TOKEN',
    'SMTP_PASS',
    'SMTP_USER',
    'WEBHOOK_SECRET',
    'ADMIN_TOKEN',
)


def load_env():
    """读取工作区根目录的 .env，返回键值字典。

    参数：无。
    返回：dict[str, str]，只取形如 KEY=VALUE 的行，忽略注释与空行。
    说明：本函数不会打印任何值；调用方负责脱敏。
    """
    values = {}
    env_file = ROOT / '.env'
    if not env_file.exists():
        raise SystemExit('找不到 .env，请在项目根目录放好配置后再运行。')

    for raw in env_file.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def collect_secrets(env):
    """收集所有需要在输出中屏蔽的敏感字符串。

    参数：env —— load_env() 返回的字典。
    返回：list[str]，按长度降序（先替换长串，避免短串破坏长串的匹配）。
    """
    secrets = []
    for key in SENSITIVE_ENV_KEYS:
        value = env.get(key, '')
        if value and len(value) >= 4:
            secrets.append(value)

    # SSH_URI 的整体、用户名、密码都要单独屏蔽：
    # 用户名本身就是一次性访问凭证，不能出现在任何日志里。
    uri = env.get('SSH_URI', '')
    parsed = urlparse(uri)
    for piece in (uri, parsed.username, parsed.password, parsed.hostname):
        if piece and len(piece) >= 4:
            secrets.append(piece)

    return sorted(set(secrets), key=len, reverse=True)


def redact(text, secrets):
    """把文本中出现的敏感串替换成占位符。

    参数：text —— 待处理的远端输出；secrets —— collect_secrets() 的结果。
    返回：脱敏后的字符串。
    """
    for secret in secrets:
        text = text.replace(secret, '<redacted>')
    return text


def open_connection(env):
    """用 none 认证建立 SSH 传输层，建连失败时做有限重试。

    参数：env —— 含 SSH_URI 的配置字典。
    返回：(paramiko.Transport, socket.socket)，调用方负责成对关闭。
    说明：instabox 服务端接受 auth_none，因此不需要任何私钥或密码；
          这里不调用 load_system_host_keys，也就不触碰本机 ~/.ssh。
          临时沙箱偶尔在建连阶段直接断流（读不到 SSH banner），
          所以只重试「建立连接」这一步；连接成功后的命令绝不重试，
          防止有副作用的操作被重复执行。
    """
    uri = env.get('SSH_URI', '')
    parsed = urlparse(uri)
    if not parsed.hostname or not parsed.username:
        raise SystemExit('SSH_URI 格式不正确，应形如 ssh://用户名@主机:端口。')

    host = parsed.hostname
    port = parsed.port or 22
    user = parsed.username

    last_error = None
    for attempt in range(1, CONNECT_ATTEMPTS + 1):
        sock = None
        transport = None
        try:
            sock = socket.create_connection((host, port), timeout=15)
            transport = paramiko.Transport(sock)
            transport.start_client(timeout=15)
            transport.auth_none(user)
            # 镜像构建可能耗时数分钟，定期发 keepalive 防止中间设备掐断空闲连接
            transport.set_keepalive(30)
            print(f'已连接远端（主机 {host}:{port}，none 认证）')
            return transport, sock
        except (OSError, EOFError, paramiko.SSHException) as error:
            last_error = error
            if transport is not None:
                transport.close()
            if sock is not None:
                sock.close()
            # 异常只打印类型名，避免把带凭据的上下文带进日志
            print(f'第 {attempt} 次建连失败（{type(error).__name__}）')
            if attempt < CONNECT_ATTEMPTS:
                time.sleep(CONNECT_RETRY_DELAY)

    raise SystemExit(
        f'连续 {CONNECT_ATTEMPTS} 次无法连接远端：{type(last_error).__name__}'
    )


def run_remote(transport, command, secrets, timeout=300):
    """在远端执行一条 shell 命令并取回输出。

    参数：transport —— 已认证的传输层；command —— 远端命令字符串；
          secrets —— 脱敏串列表；timeout —— 读超时秒数。
    返回：(退出码, 脱敏后的 stdout, 脱敏后的 stderr)。
    """
    channel = transport.open_session(timeout=15)
    channel.settimeout(timeout)
    try:
        channel.exec_command(command)
        stdout = channel.makefile('rb').read().decode('utf-8', 'replace')
        stderr = channel.makefile_stderr('rb').read().decode('utf-8', 'replace')
        exit_code = channel.recv_exit_status()
    finally:
        channel.close()

    return exit_code, redact(stdout, secrets), redact(stderr, secrets)


def print_result(exit_code, stdout, stderr):
    """统一打印远端命令结果，返回该命令的退出码。

    参数：exit_code / stdout / stderr —— run_remote() 的三元组。
    返回：int，供 main() 作为进程退出码。
    """
    if stdout.strip():
        print(stdout.rstrip())
    if stderr.strip():
        print('--- 远端 stderr ---')
        print(stderr.rstrip()[:2000])
    print(f'远端退出码：{exit_code}')
    return exit_code


def make_source_tarball():
    """按白名单把源码打进一个临时 tar.gz。

    参数：无。
    返回：Path，临时压缩包路径；调用方用完需删除。
    说明：逐个文件显式加入，而不是整目录打包，这样 .env 绝无可能被带出去。
    """
    handle, temp_name = tempfile.mkstemp(prefix='notify-src-', suffix='.tar.gz')
    os.close(handle)
    temp_path = Path(temp_name)

    with tarfile.open(temp_path, 'w:gz') as tar:
        for item in INCLUDE_ITEMS:
            source = ROOT / item
            if not source.exists():
                continue
            if source.is_file():
                tar.add(source, arcname=item)
                continue

            for file_path in sorted(source.rglob('*')):
                if not file_path.is_file():
                    continue
                if file_path.suffix == '.pyc' or file_path.name in EXCLUDE_FILE_NAMES:
                    continue
                relative = file_path.relative_to(ROOT).as_posix()
                if relative in EXCLUDE_RELATIVE_PATHS:
                    continue
                tar.add(file_path, arcname=relative)

    return temp_path


def command_check(transport, secrets):
    """check：只读盘点远端环境，不修改任何东西。

    参数：transport —— 已认证传输层；secrets —— 脱敏串列表。
    返回：int 退出码。
    """
    command = (
        'echo "=== 运行时 ==="; '
        'printf "node: "; node --version; '
        'printf "npm: "; npm --version; '
        'printf "bun: "; bun --version; '
        'printf "docker: "; docker --version; '
        'printf "compose: "; docker compose version; '
        'echo "=== 8788 端口 ==="; (ss -ltnp 2>/dev/null | grep 8788 || echo FREE); '
        'echo "=== 现有 Notify 容器 ==="; '
        "(docker ps -a --format '{{.Names}} {{.Status}}' | grep notify || echo NONE); "
        'echo "=== 磁盘 ==="; df -h / | tail -1'
    )
    return print_result(*run_remote(transport, command, secrets))


def command_sync(transport, secrets):
    """sync：把白名单源码同步到远端独立目录。

    参数：transport —— 已认证传输层；secrets —— 脱敏串列表。
    返回：int 退出码。
    说明：远端会先建目录再解压；压缩包用完即删，不留在 VPS 上。
    """
    tarball = make_source_tarball()
    remote_tarball = REMOTE_DIR + '/source.tar.gz'
    try:
        _, stdout, _ = run_remote(
            transport,
            f'mkdir -p {REMOTE_APP_DIR} && echo READY',
            secrets,
        )
        print(stdout.strip())

        sftp = paramiko.SFTPClient.from_transport(transport)
        try:
            sftp.put(str(tarball), remote_tarball)
        finally:
            sftp.close()

        command = (
            f'tar -xzf {remote_tarball} -C {REMOTE_APP_DIR} '
            f'&& rm -f {remote_tarball} '
            f'&& echo "同步完成：" && ls -a {REMOTE_APP_DIR} '
            f'&& echo "文件数：$(find {REMOTE_APP_DIR} -type f | wc -l)"'
        )
        return print_result(*run_remote(transport, command, secrets))
    finally:
        if tarball.exists():
            tarball.unlink()


def command_test(transport, secrets):
    """test：在远端跑完整单测，只打印尾部摘要以免刷屏。

    参数：transport —— 已认证传输层；secrets —— 脱敏串列表。
    返回：int 退出码（npm test 的真实退出码）。
    """
    command = (
        f'cd {REMOTE_APP_DIR} && npm test > /tmp/notify-test.log 2>&1; '
        'code=$?; tail -22 /tmp/notify-test.log; echo "TEST_EXIT=$code"; exit $code'
    )
    return print_result(*run_remote(transport, command, secrets, timeout=300))


def command_build(transport, secrets):
    """build：在远端用 Dockerfile 构建本地测试镜像，不启动容器。

    参数：transport —— 已认证传输层；secrets —— 脱敏串列表。
    返回：int 退出码。
    说明：只打本地标签，不 push、不覆盖其它镜像；构建日志保留尾部。
    """
    command = (
        f'cd {REMOTE_APP_DIR} && docker build -t {IMAGE_TAG} . '
        '> /tmp/notify-build.log 2>&1; '
        'code=$?; tail -35 /tmp/notify-build.log; '
        f'[ "$code" -eq 0 ] && docker images {IMAGE_TAG}; '
        'echo "BUILD_EXIT=$code"; exit $code'
    )
    return print_result(*run_remote(transport, command, secrets, timeout=600))


def command_smoke(transport, secrets):
    """smoke：在隔离网络里验证镜像中的 Bun 能加载项目 TypeScript 模块。

    参数：transport —— 已认证传输层；secrets —— 脱敏串列表。
    返回：int 退出码。
    说明：容器用 --rm 且 --network none，不挂卷、不注入任何凭据，
          所以既不会外联 Cloud，也不会发邮件，纯验证打包产物是否可运行。
    """
    command = (
        f'docker run --rm --network none {IMAGE_TAG} '
        'bun -e \'import("./src/rules/reminder-plan.ts")'
        '.then(m => console.log("MODULE_OK exports=" + Object.keys(m).length))'
        '.catch(e => { console.error(e); process.exit(1) })\''
    )
    return print_result(*run_remote(transport, command, secrets, timeout=120))


def main():
    """解析子命令并分派，返回进程退出码。

    参数：无（从 sys.argv 读取）。
    返回：int，0 表示成功。
    """
    parser = argparse.ArgumentParser(description='Notify 远端构建/测试助手')
    parser.add_argument(
        'command',
        choices=('check', 'sync', 'test', 'build', 'smoke'),
        help='check=只读盘点，sync=同步源码，test=远端单测，build=构建镜像，smoke=镜像冒烟',
    )
    args = parser.parse_args()

    env = load_env()
    secrets = collect_secrets(env)
    transport, sock = open_connection(env)
    try:
        handlers = {
            'check': command_check,
            'sync': command_sync,
            'test': command_test,
            'build': command_build,
            'smoke': command_smoke,
        }
        return handlers[args.command](transport, secrets)
    finally:
        transport.close()
        sock.close()


if __name__ == '__main__':
    sys.exit(main())
