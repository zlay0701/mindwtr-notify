/**
 * 邮件通道（EXT-01【增强】）
 *
 * 零第三方依赖的最小 SMTP 客户端：支持 465 隐式 TLS、587 STARTTLS、AUTH LOGIN。
 * 只实现发送纯文本/HTML 邮件所需的最小命令集，不做连接池、附件与 DKIM。
 * 若将来需要更完整的协议支持，只要替换 MailTransport 实现即可，分发器不感知。
 *
 * 安全：密码只在 AUTH 步骤以 base64 形式发给 SMTP 服务器，绝不写入日志或异常文本。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { NotifyConfig } from '../config.ts';
import type { EmailContent } from './message.ts';

/** 分发器只依赖这个接口，便于测试时注入假的 transport。 */
export interface MailTransport {
  send(mail: EmailContent): Promise<void>;
}

type AnySocket = Socket | TLSSocket;

/** RFC 2047：非 ASCII 的邮件头（如中文主题）必须编码，否则会被服务器拒收。 */
function encodeHeader(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/**
 * 构造 RFC822 原始邮件。
 * 正文用 base64 编码：不少 SMTP 服务器不支持 8BITMIME，直接发中文会乱码或截断。
 */
export function buildRawMail(mail: EmailContent, from: string, fromName: string): string {
  const headers = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
  ];
  const encoded = Buffer.from(mail.html || mail.text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${encoded}\r\n`;
}

/**
 * 逐行读取 SMTP 响应。detach 用于 STARTTLS 升级前摘掉旧 socket 的监听器。
 *
 * 为什么要有 pendingLines 队列：EHLO 的响应通常是多行（若干 `250-xxx` 续行 +
 * 一行 `250 xxx` 结束行），而且经常在同一个 data 事件里一次性到达。
 * readResponse() 每读到一行才 await 下一次 readLine()，此时若没有等待中的 Promise，
 * 后续行就会被直接丢掉，导致永远等不到结束行、真实 SMTP 会话挂起。
 * 所以没有等待者时先把整行缓存下来，readLine() 优先取缓存。
 */
function createLineReader(socket: AnySocket) {
  let buffer = '';
  /** 已收到但还没有被读走的完整行。 */
  const pendingLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pendingLines.push(line);
      index = buffer.indexOf('\r\n');
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', onData);

  return {
    readLine(): Promise<string> {
      const cached = pendingLines.shift();
      if (cached !== undefined) return Promise.resolve(cached);
      return new Promise(resolve => waiters.push(resolve));
    },
    detach(): void {
      socket.removeListener('data', onData);
    },
  };
}

type LineReader = ReturnType<typeof createLineReader>;

/** SMTP 响应可能有多行（250-xxx 续行，250 xxx 结束），要读到结束行为止。 */
async function readResponse(reader: LineReader): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine();
    lines.push(line);
    const match = /^(\d{3})([ -])/.exec(line);
    if (match && match[2] === ' ') return { code: Number(match[1]), lines };
  }
}

/** 发一条命令并校验响应码。只把命令名写进错误，绝不回显 AUTH 的内容。 */
async function command(
  socket: AnySocket,
  reader: LineReader,
  text: string,
  expected: number[],
): Promise<string[]> {
  socket.write(`${text}\r\n`);
  const response = await readResponse(reader);
  if (!expected.includes(response.code)) {
    throw new Error(`SMTP ${text.split(' ')[0]} 返回 ${response.code}`);
  }
  return response.lines;
}

/** 等待 TCP 或 TLS 连接建立，带超时。 */
function waitForConnect(socket: AnySocket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP 连接超时')), 15_000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once(event, () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * 通过 SMTP 发送一封邮件。
 * 调用方应先用 createSmtpTransport 判断配置是否齐全。
 */
export async function sendViaSmtp(config: NotifyConfig, mail: EmailContent): Promise<void> {
  const smtp = config.channels.email;
  let socket: AnySocket = smtp.secure
    ? tlsConnect({ host: smtp.host, port: smtp.port, servername: smtp.host })
    : netConnect({ host: smtp.host, port: smtp.port });

  await waitForConnect(socket, smtp.secure ? 'secureConnect' : 'connect');
  let reader = createLineReader(socket);

  try {
    await readResponse(reader); // 服务端 220 欢迎语
    const ehlo = await command(socket, reader, 'EHLO localhost', [250]);

    // 587 端口通常要求先 STARTTLS 再认证。
    if (!smtp.secure && smtp.requireTls) {
      if (!ehlo.some(line => /STARTTLS/i.test(line))) throw new Error('SMTP 服务器不支持 STARTTLS');
      await command(socket, reader, 'STARTTLS', [220]);
      reader.detach();
      socket = tlsConnect({ socket, servername: smtp.host });
      await waitForConnect(socket, 'secureConnect');
      reader = createLineReader(socket);
      // TLS 升级后必须重新 EHLO，之前的 capability 列表已失效。
      await command(socket, reader, 'EHLO localhost', [250]);
    }

    if (smtp.user && smtp.password) {
      await command(socket, reader, 'AUTH LOGIN', [334]);
      await command(socket, reader, Buffer.from(smtp.user, 'utf8').toString('base64'), [334]);
      await command(socket, reader, Buffer.from(smtp.password, 'utf8').toString('base64'), [235]);
    }

    await command(socket, reader, `MAIL FROM:<${smtp.from}>`, [250]);
    for (const recipient of mail.to) {
      await command(socket, reader, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await command(socket, reader, 'DATA', [354]);
    socket.write(`${buildRawMail(mail, smtp.from, smtp.fromName)}\r\n.\r\n`);
    await readResponse(reader); // 250 已入队
    socket.write('QUIT\r\n');
  } finally {
    reader.detach();
    socket.end();
  }
}

/** 配置齐全时返回真实 SMTP transport，否则返回 null（dry-run 可据此跳过）。 */
export function createSmtpTransport(config: NotifyConfig): MailTransport | null {
  const smtp = config.channels.email;
  if (!smtp.enabled || !smtp.host || !smtp.from || !smtp.to.length) return null;
  return { send: mail => sendViaSmtp(config, mail) };
}

/**
 * 本地文件 transport：dry-run、单元测试、没有 SMTP 账号时的落盘通道。
 * 便于确认「确实生成了邮件内容」而不真的发信。
 */
export function createFileTransport(path: string): MailTransport {
  mkdirSync(dirname(path), { recursive: true });
  return {
    async send(mail: EmailContent): Promise<void> {
      appendFileSync(
        path,
        `--- ${new Date().toISOString()} ---\nTo: ${mail.to.join(', ')}\nSubject: ${mail.subject}\n\n${mail.text}\n\n`,
        'utf8',
      );
    },
  };
}
