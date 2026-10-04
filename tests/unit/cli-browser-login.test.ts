import { spawn as nodeSpawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { CliSandbox, browserLogin } from '../src/fixtures/cli';

/**
 * Characterization tests for the CLI browser-login fixture (KRTX-1432). They
 * drive the REAL `kortix login` process through `browserLogin` — the
 * incremental stdout reader that parses the authorize URL, the loopback
 * callback POST with its bounded retries, the state-mismatch early kill, the
 * process-budget killer, and the returned `callback` evidence — against a stub
 * loopback API, so the behavior-preserving refactor is judged against exactly
 * what these tests saw before it.
 */

interface StubRequest {
  method: string;
  path: string;
  authorization: string | null;
}

let stubApiPort = 0;
const stubRequests: StubRequest[] = [];
let stubServer: Server | null = null;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    stubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        stubRequests.push({
          method: String(req.method),
          path: String(req.url),
          authorization: req.headers.authorization ?? null,
        });
        if (req.url === '/v1/accounts/me') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              user_id: 'user-1432',
              email: 'browser-login@example.test',
              accounts: [],
            }),
          );
          return;
        }
        if (req.url === '/v1/projects') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub has no route' }));
      });
    });
    stubServer.listen(0, '127.0.0.1', () => {
      const address = stubServer?.address();
      stubApiPort = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  stubServer?.close();
});

/**
 * Adapt node's child_process to the Bun.Subprocess shape the fixture reads:
 * `stdout`/`stderr` as web ReadableStreams (the fixture locks stdout with
 * getReader() and passes stderr to `new Response(...).text()`), `exited` as a
 * promise of the exit code (Bun reports a signaled process as 128 + signal),
 * and `kill()`.
 */
function bunSpawnShim(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: unknown },
): {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill(): void;
} {
  const [entry, ...rest] = argv;
  if (!entry) throw new Error('the CLI shim needs an argv');
  const child = nodeSpawn(entry, rest, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.stdout || !child.stderr) throw new Error('the CLI shim needs piped streams');
  return {
    pid: child.pid ?? 0,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    exited: new Promise<number>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve(signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : (code ?? -1));
      });
    }),
    exitCode: child.exitCode,
    kill: () => child.kill(),
  };
}

/** The state the CLI printed in its authorize URL. */
function printedState(stdout: string): string {
  const match = stdout.match(/callback=([^&\s]+)&state=([0-9a-f]+)/i);
  if (!match) throw new Error(`no authorize URL in stdout: ${stdout.slice(0, 400)}`);
  const state = match[2];
  if (!state) throw new Error('the authorize URL carried no state');
  return state;
}

describe('browserLogin against a stub loopback API (characterization)', () => {
  test('delivers the minted token to the callback and the CLI saves the host', async () => {
    process.env.KE2E_API_URL = `http://127.0.0.1:${stubApiPort}/v1`;
    vi.stubGlobal('Bun', { spawn: bunSpawnShim });
    const sb = new CliSandbox('browser-login-ok');
    try {
      const pat = 'kortix_pat_testtoken1432';
      const result = await browserLogin(sb, pat);

      expect(result.exitCode).toBe(0);
      expect(result.callback).toEqual({
        status: 200,
        body: JSON.stringify({ ok: true }),
        attempts: 1,
        error: null,
      });
      // The callback carried exactly the state the CLI printed.
      expect(result.stdout).toContain('state=');
      const callbackBody = result.callback?.body ?? '';
      expect(JSON.parse(callbackBody)).toEqual({ ok: true });
      // The CLI verified the token against the stub API and saved the host.
      expect(sb.isLoggedIn()).toBe(true);
      const config = sb.readConfig();
      const active = config.active;
      expect(config.hosts[active].token).toBe(pat);
      expect(
        stubRequests.some(
          (r) => r.path === '/v1/accounts/me' && r.authorization === `Bearer ${pat}`,
        ),
      ).toBe(true);
    } finally {
      sb.dispose();
    }
  }, 60_000);

  test('a rejected state returns 403 and the fixture stops the waiting CLI', async () => {
    process.env.KE2E_API_URL = `http://127.0.0.1:${stubApiPort}/v1`;
    vi.stubGlobal('Bun', { spawn: bunSpawnShim });
    const sb = new CliSandbox('browser-login-bad');
    try {
      const result = await browserLogin(sb, 'kortix_pat_testtoken1432', { badState: true });

      expect(result.callback?.status).toBe(403);
      expect(result.callback?.attempts).toBe(1);
      // The state mismatch is the only exit: the fixture's early kill ends it.
      expect(result.exitCode).toBe(143);
      // The rejected login wrote no host record.
      expect(sb.isLoggedIn()).toBe(false);
    } finally {
      sb.dispose();
    }
  }, 60_000);
});
