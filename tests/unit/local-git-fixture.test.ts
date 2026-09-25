/**
 * The local-git fixture answers a request only after its body has ended.
 *
 * `git receive-pack` can exit before the chunked body's terminator arrives.
 * The fixture used to answer at that moment. The API's fetch then reused the
 * keep-alive socket while the server was still parsing the old body, and the
 * next request failed parsing with a bare 400 before the handler ran: the
 * GH-17 / AGP-10 core-lane flakes of 2026-09-23.
 *
 * A raw socket makes the timing exact: the terminator is held back until the
 * test has proved no answer was sent, and the next request rides the same
 * connection.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { type Socket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFixtureRepoLocally } from '../src/fixtures/local-git';

let dir = '';
let server: Server | null = null;
let port = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ke2e-local-git-fixture-'));
  const bare = join(dir, 'remote.git');
  // Before the server starts: a synchronous git here blocks nothing.
  expect(spawnSync('git', ['init', '--bare', '-q', bare]).status).toBe(0);
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rows: [{ repo_url: bare }] };
      port = Number(new URL(String(params?.[0])).port);
      return { rows: [] };
    },
  };
  server = await serveFixtureRepoLocally({ env: { target: 'local' } }, db, 'project', 'UNIT');
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function statusLines(buffer: string): string[] {
  return [...buffer.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1] ?? '');
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

describe('serveFixtureRepoLocally', () => {
  it('answers a push only after its body ends, and serves the next request on the same socket', async () => {
    const socket: Socket = connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    // A receive-pack body of one flush packet: no commands, so git exits at once.
    socket.write(
      'POST /git-receive-pack HTTP/1.1\r\nHost: fixture\r\n' +
        'Content-Type: application/x-git-receive-pack-request\r\n' +
        'Transfer-Encoding: chunked\r\n\r\n' +
        '4\r\n0000\r\n',
    );
    // git has exited long before this; the body has not ended, so no answer yet.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toBe('');

    socket.write('0\r\n\r\n');
    expect(await waitFor(() => statusLines(received).length === 1, 5_000)).toBe(true);

    socket.write('GET /info/refs?service=git-upload-pack HTTP/1.1\r\nHost: fixture\r\n\r\n');
    expect(await waitFor(() => statusLines(received).length === 2, 5_000)).toBe(true);
    expect(statusLines(received)).toEqual(['200', '200']);
    socket.destroy();
  });
});
