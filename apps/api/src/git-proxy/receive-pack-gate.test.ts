/**
 * End-to-end proof of the push gate, driven by a REAL `git push` process.
 *
 * The unit tests cover the parser and the policy in isolation. This one covers
 * what neither can: that the bytes the proxy writes back are bytes git accepts,
 * and that a refusal reaches the user as a git rejection rather than a broken
 * transport. Both protocol traps this file guards against were live bugs found
 * against git 2.39.1 — a missing sideband band byte (`bad band #117`) and a
 * pkt-line length counted in characters instead of bytes.
 *
 * The whole path runs for real: git's own wire protocol, the real Hono app, the
 * real parser, the real policy. Only the authorization verdict and the upstream
 * are stood in for, because neither is what this test is about.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const PROJECT_ID = 'b06a70f1-be0a-4fd0-b052-26fffb92713f';
const SESSION_ID = '9bf3acd4-85bc-46fe-a938-e61404e00270';
const DEFAULT_BRANCH = 'main';

/** Swapped per test to impersonate each class of credential. */
let principal: any = { kind: 'user', userId: 'user-1' };
/** The agent grant the scope resolver reads; null = an ungoverned project. */
let agentGrant: any = null;
/** Refs the fake upstream actually received — empty means nothing was forwarded. */
let upstreamReceived: string[] = [];

const realProjects = await import('../projects');
mock.module('../projects', () => ({
  ...realProjects,
  authorizeGitProxy: async () => ({
    ok: true,
    principal,
    project: { projectId: PROJECT_ID, defaultBranch: DEFAULT_BRANCH, metadata: {} },
  }),
  resolveProjectUpstream: async () => ({ url: upstreamUrl, headers: {} }),
}));

const { gitProxyApp, __resetGitProxyMemosForTests } = await import('./index');

const pkt = (s: string) => (Buffer.byteLength(s, 'utf8') + 4).toString(16).padStart(4, '0') + s;
const ZERO = '0'.repeat(40);
/** Stand-in tip for every ref the fake upstream advertises. */
const REMOTE_SHA = 'c'.repeat(39) + '7';

let proxyServer: ReturnType<typeof Bun.serve>;
let upstreamServer: ReturnType<typeof Bun.serve>;
let upstreamUrl = '';
let proxyBase = '';
let workdir = '';

beforeAll(async () => {
  // Stands in for GitHub: advertises one ref, accepts any push, records it.
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/info/refs')) {
        // Advertise the refs the tests operate on. An "empty repository"
        // advertisement would make git refuse a delete client-side ("remote ref
        // does not exist") and the push would never reach the gate under test.
        const advertised = [
          'refs/heads/main',
          'refs/heads/feature',
          `refs/heads/${SESSION_ID}`,
        ];
        // `delete-refs` is REQUIRED for the delete cases to reach the server at
        // all: without it git rejects a deletion client-side, and a test that
        // asserts only "[remote rejected]" would pass while exercising nothing.
        const caps =
          'report-status report-status-v2 delete-refs side-band-64k ofs-delta object-format=sha1';
        const body =
          pkt('# service=git-receive-pack\n') +
          '0000' +
          advertised
            .map((ref, i) =>
              pkt(i === 0 ? `${REMOTE_SHA} ${ref}\0${caps}\n` : `${REMOTE_SHA} ${ref}\n`),
            )
            .join('') +
          '0000';
        return new Response(body, {
          headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
        });
      }
      const body = Buffer.from(await req.arrayBuffer()).toString('latin1');
      const refs = [...body.matchAll(/[0-9a-f]{40} [0-9a-f]{40} (refs\/[^\0\n]+)/g)].map(
        (m) => m[1]!,
      );
      upstreamReceived.push(...refs);
      const inner = pkt('unpack ok\n') + refs.map((r) => pkt(`ok ${r}\n`)).join('') + '0000';
      const framed = Buffer.concat([
        Buffer.from(
          (Buffer.byteLength(inner) + 5).toString(16).padStart(4, '0') + '\x01',
          'latin1',
        ),
        Buffer.from(inner, 'latin1'),
        Buffer.from('0000', 'latin1'),
      ]);
      return new Response(framed, {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
      });
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstreamServer.port}/upstream.git`;

  // The scope resolver reads the agent grant off the request context, which the
  // auth middleware sets in production. Hono collects handlers in REGISTRATION
  // order and this app's routes exist at import time, so a `use('*')` added
  // here would run AFTER them. A parent app shares the context with a routed
  // sub-app, which injects the grant without mocking a module process-wide.
  const host = new Hono();
  host.use('*', async (c, next) => {
    c.set('agentGrant' as never, agentGrant as never);
    await next();
  });
  host.route('/', gitProxyApp);
  proxyServer = Bun.serve({ port: 0, fetch: (req) => host.fetch(req) });
  proxyBase = `http://127.0.0.1:${proxyServer.port}/${PROJECT_ID}.git`;

  // A real local repo with real commits to push.
  workdir = mkdtempSync(join(tmpdir(), 'kortix-gate-'));
  await git(['init', '-q', '-b', DEFAULT_BRANCH, '.']);
  for (const n of [1, 2]) {
    await Bun.write(join(workdir, `f${n}.txt`), `line ${n}\n`);
    await git(['add', '-A']);
    await git(['-c', 'user.email=t@k.ai', '-c', 'user.name=t', 'commit', '-qm', `c${n}`]);
  }
  await git(['remote', 'add', 'origin', proxyBase]);
});

afterAll(() => {
  proxyServer?.stop(true);
  upstreamServer?.stop(true);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/**
 * Always ASYNC. `spawnSync` would block this thread, and `Bun.serve` answers on
 * the same event loop — a synchronous git process and the proxy it is talking
 * to deadlock each other instantly.
 */
async function git(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
    // Never let git block on a credential prompt inside a test.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

/**
 * Run a real `git push` and return what the user would see.
 *
 * The credential is a real Basic header in the shape the proxy parses (token in
 * the password slot); the VERDICT it produces is mocked, but the proxy's own
 * `authorize()` still refuses a request with no Authorization header at all, so
 * the header has to be here.
 */
async function push(...args: string[]): Promise<{ code: number; output: string }> {
  upstreamReceived = [];
  __resetGitProxyMemosForTests();
  const basic = Buffer.from('x-access-token:kortix_test_token').toString('base64');
  return git(['-c', `http.extraHeader=Authorization: Basic ${basic}`, 'push', ...args]);
}

describe('a session principal', () => {
  beforeAll(() => {
    principal = { kind: 'session', sessionId: SESSION_ID, branch: SESSION_ID };
  });

  test('is refused pushing the default branch, as a git rejection', async () => {
    const { code, output } = await push('--force', 'origin', `${DEFAULT_BRANCH}:refs/heads/main`);
    expect(code).not.toBe(0);
    // The native git rejection shape — not a transport error.
    expect(output).toContain('[remote rejected]');
    // git renders the SHORT ref name in this line, not the fully-qualified one.
    expect(output).toContain('main -> main');
    expect(output).toContain('own branch');
    // Neither of the protocol traps this guards against.
    expect(output).not.toContain('bad band');
    expect(output).not.toContain('bad line length');
    expect(output).not.toContain('hung up unexpectedly');
    // Nothing was forwarded: the pack never left the client.
    expect(upstreamReceived).toEqual([]);
  });

  test('is refused pushing another session branch', async () => {
    const { code, output } = await push('--force', 'origin', `HEAD:refs/heads/${'1'.repeat(8)}-other`);
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    expect(upstreamReceived).toEqual([]);
  });

  test('is refused deleting another branch', async () => {
    const { code, output } = await push('origin', '--delete', 'refs/heads/feature');
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    // The reason proves the refusal came from OUR gate. Without it, git's own
    // client-side refusal would satisfy `[remote rejected]` just as well.
    expect(output).toContain('own branch');
    expect(upstreamReceived).toEqual([]);
  });

  test('deleting the default branch hits the structural floor, not the session rule', async () => {
    const { code, output } = await push('origin', '--delete', 'refs/heads/main');
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    expect(output).toContain('cannot be deleted');
    expect(upstreamReceived).toEqual([]);
  });

  test('the refusal names the branch it MAY push, so an agent can recover', async () => {
    const { output } = await push('--force', 'origin', `${DEFAULT_BRANCH}:refs/heads/main`);
    expect(output).toContain(SESSION_ID);
    expect(output).toContain('change request');
  });

  test('CAN push its own branch, and the pack reaches the upstream', async () => {
    const { code, output } = await push('--force', 'origin', `HEAD:refs/heads/${SESSION_ID}`);
    expect(output).not.toContain('[remote rejected]');
    expect(code).toBe(0);
    expect(upstreamReceived).toEqual([`refs/heads/${SESSION_ID}`]);
  });

  test('a mixed push is refused whole — no partial forward', async () => {
    const { code, output } = await push(
      '--force',
      'origin',
      `HEAD:refs/heads/${SESSION_ID}`,
      'HEAD:refs/heads/main',
    );
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    // The allowed ref must NOT have been forwarded on its own: the pack is one
    // stream and cannot be split.
    expect(upstreamReceived).toEqual([]);
  });
});

describe('a user principal', () => {
  beforeAll(() => {
    principal = { kind: 'user', userId: 'user-1' };
  });

  test('CAN push the default branch — `kortix ship` on main still works', async () => {
    const { code } = await push('--force', 'origin', `${DEFAULT_BRANCH}:refs/heads/main`);
    expect(code).toBe(0);
    expect(upstreamReceived).toEqual(['refs/heads/main']);
  });

  test('CAN push and delete an ordinary branch', async () => {
    expect((await push('--force', 'origin', 'HEAD:refs/heads/feature')).code).toBe(0);
    const { code } = await push('origin', '--delete', 'refs/heads/feature');
    expect(code).toBe(0);
    expect(upstreamReceived).toEqual(['refs/heads/feature']);
  });

  test('is refused deleting the default branch', async () => {
    const { code, output } = await push('origin', '--delete', 'refs/heads/main');
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    expect(output).toContain('cannot be deleted');
    expect(upstreamReceived).toEqual([]);
  });
});

describe('a session GRANTED project.gitops.ref.any', () => {
  beforeAll(() => {
    principal = { kind: 'session', sessionId: SESSION_ID, branch: SESSION_ID };
    agentGrant = { agent: 'main', kortixCli: ['project.gitops.ref.any'] };
  });
  afterAll(() => {
    agentGrant = null;
  });

  test('CAN push another branch — the scope is what makes it deliberate', async () => {
    const { code, output } = await push('--force', 'origin', 'HEAD:refs/heads/shared');
    expect(output).not.toContain('[remote rejected]');
    expect(code).toBe(0);
    expect(upstreamReceived).toEqual(['refs/heads/shared']);
  });

  test('is STILL refused deleting the default branch — a floor no grant lifts', async () => {
    const { code, output } = await push('origin', '--delete', 'refs/heads/main');
    expect(code).not.toBe(0);
    expect(output).toContain('cannot be deleted');
    expect(upstreamReceived).toEqual([]);
  });

  test('is STILL refused deleting another branch — that needs the delete scope', async () => {
    const { code, output } = await push('origin', '--delete', 'refs/heads/feature');
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    expect(upstreamReceived).toEqual([]);
  });
});

describe('a monitor principal', () => {
  beforeAll(() => {
    principal = { kind: 'monitor' };
  });

  test('cannot push anything', async () => {
    const { code, output } = await push('--force', 'origin', 'HEAD:refs/heads/whatever');
    expect(code).not.toBe(0);
    expect(output).toContain('[remote rejected]');
    expect(output).toContain('read-only');
    expect(upstreamReceived).toEqual([]);
  });
});
