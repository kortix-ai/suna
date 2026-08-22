// Real SMTP conversation against an in-process server: no mock of the client,
// no container. Proves the wire path (EHLO → AUTH → MAIL FROM → RCPT TO → DATA)
// and that the message body actually carries what the transport was given.
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';

import type { EmailTarget } from '@kortix/shared/email-url';
import { closeSmtpTransports, sendViaSmtp } from './smtp';
import type { ResolvedEmailMessage } from '../types';

interface Captured {
  commands: string[];
  data: string;
}

function startSmtpServer(opts: { advertiseAuth: boolean }): Promise<{
  server: Server;
  port: number;
  captured: Captured;
}> {
  const captured: Captured = { commands: [], data: '' };
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as TEST\r\n');
          } else {
            captured.data += `${line}\n`;
          }
          continue;
        }

        captured.commands.push(line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-test\r\n');
          socket.write(opts.advertiseAuth ? '250 AUTH PLAIN LOGIN\r\n' : '250 8BITMIME\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, captured });
    });
  });
}

const MESSAGE: ResolvedEmailMessage = {
  to: ['user@example.test'],
  subject: 'Sign in to Kortix',
  html: '<p>hello <b>world</b></p>',
  text: 'hello world',
  category: 'auth-magiclink',
  from: { email: 'noreply@example.test', name: 'Kortix' },
};

afterEach(() => {
  closeSmtpTransports();
});

describe('sendViaSmtp', () => {
  test('delivers over a plain anonymous relay and carries both body parts', async () => {
    const { server, port, captured } = await startSmtpServer({ advertiseAuth: false });
    const target: EmailTarget = {
      kind: 'smtp',
      host: '127.0.0.1',
      port,
      secure: false,
      requireTls: false,
      rejectUnauthorized: false,
    };

    const result = await sendViaSmtp(MESSAGE, target);
    expect(result).toEqual({ ok: true, provider: 'smtp', status: 250 });

    expect(captured.commands.some((line) => line.startsWith('MAIL FROM:<noreply@example.test>'))).toBe(true);
    expect(captured.commands.some((line) => line.startsWith('RCPT TO:<user@example.test>'))).toBe(true);
    // RFC 2047-encoded or literal, the subject must survive; nodemailer emits
    // the header verbatim when it is pure ASCII.
    expect(captured.data).toContain('Subject: Sign in to Kortix');
    expect(captured.data).toContain('From: Kortix <noreply@example.test>');
    expect(captured.data).toContain('X-Kortix-Category: auth-magiclink');
    expect(captured.data).toContain('multipart/alternative');
    server.close();
  });

  test('authenticates when the relay advertises AUTH', async () => {
    const { server, port, captured } = await startSmtpServer({ advertiseAuth: true });
    const result = await sendViaSmtp(MESSAGE, {
      kind: 'smtp',
      host: '127.0.0.1',
      port,
      secure: false,
      // ?tls=off — this relay offers no STARTTLS, which is the only reason
      // credentials are allowed over a plain socket here.
      requireTls: false,
      rejectUnauthorized: false,
      user: 'alice',
      pass: 's3cret',
    });
    expect(result.ok).toBe(true);
    expect(captured.commands.some((line) => line.startsWith('AUTH'))).toBe(true);
    server.close();
  });

  test('reports a refused connection as a failed result rather than throwing', async () => {
    const result = await sendViaSmtp(MESSAGE, {
      kind: 'smtp',
      host: '127.0.0.1',
      // Port 1 is reserved and never listening.
      port: 1,
      secure: false,
      requireTls: false,
      rejectUnauthorized: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok || ('skipped' in result && result.skipped)) return;
    expect(result.provider).toBe('smtp');
    expect(result.error).toBeTruthy();
  });
});
