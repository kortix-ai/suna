import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Black-box reproduction of KRTX-1705: the real `kortix` process, two real
// HTTP APIs — the deployment the platform injected into the sandbox, and the
// deployment the user logged into and selected with `kortix hosts use`.
//
//   login --host self ... && hosts use self   (inside a sandbox)
//   whoami --json                              → acted as the delegated
//                                              session identity, not `self`
//
// The other half is the regression the first attempt at this fix introduced:
// a machine with a stored login where a script merely exports KORTIX_TOKEN
// must keep acting as the injected identity (env-over-stored is the default).

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');

const SESSION_USER = { user_id: 'user_session', email: 'agent@example.test' };
const OWN_USER = { user_id: 'user_own', email: 'owner@self.example' };

let tmp: string;
let envApi: ReturnType<typeof Bun.serve> | null = null;
let storedApi: ReturnType<typeof Bun.serve> | null = null;
let envRequests: string[] = [];
let storedRequests: string[] = [];

function startApi(user: { user_id: string; email: string }, log: string[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      log.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/v1/accounts/me') {
        return Response.json({
          user_id: user.user_id,
          email: user.email,
          accounts: [{ account_id: 'acct_1', slug: 'acct-1', name: 'Acct', role: 'owner' }],
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

/** A config whose active host `self` is logged in against the stored API. */
function seedOwnConfig(): void {
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify(
      {
        active: 'self',
        hosts: {
          self: {
            url: `http://127.0.0.1:${storedApi!.port}`,
            token: 'kortix_pat_own',
            user_id: OWN_USER.user_id,
            user_email: OWN_USER.email,
            account_id: 'acct_own',
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      null,
      2,
    ),
  );
}

function childEnv(withSession: boolean, extra: Record<string, string> = {}) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
  };
  if (withSession) {
    // What the platform injects into a running session.
    base.KORTIX_API_URL = `http://127.0.0.1:${envApi!.port}`;
    base.KORTIX_TOKEN = 'kortix_pat_session';
    base.KORTIX_PROJECT_ID = 'proj_session';
  }
  return { ...base, ...extra };
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-host-selection-'));
  envRequests = [];
  storedRequests = [];
  envApi = startApi(SESSION_USER, envRequests);
  storedApi = startApi(OWN_USER, storedRequests);
  seedOwnConfig();
});

afterEach(() => {
  envApi?.stop(true);
  storedApi?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

test('plain whoami acts as the injected session identity when the stored host was never selected in-sandbox', async () => {
  const { code, stdout, stderr } = await runCli(['whoami', '--json'], childEnv(true));
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const data = JSON.parse(stdout);
  expect(data.user_id).toBe(SESSION_USER.user_id);
  expect(data.url).toBe(`http://127.0.0.1:${envApi!.port}`);
  expect(storedRequests).toEqual([]);
});

test('plain whoami acts as the selected stored host after `hosts use` ran inside the sandbox (KRTX-1705)', async () => {
  const use = await runCli(['hosts', 'use', 'self'], childEnv(true));
  expect(use.code).toBe(0);

  const { code, stdout, stderr } = await runCli(['whoami', '--json'], childEnv(true));
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const data = JSON.parse(stdout);
  // The user's own deployment — its stored credential, its own base, never
  // re-pointed at the injected one.
  expect(data.user_id).toBe(OWN_USER.user_id);
  expect(data.url).toBe(`http://127.0.0.1:${storedApi!.port}`);
  expect(envRequests).toEqual([]);
});

test('a `hosts use` that ran outside a sandbox does not make the injected token lose', async () => {
  const use = await runCli(['hosts', 'use', 'self'], childEnv(false));
  expect(use.code).toBe(0);

  const { code, stdout, stderr } = await runCli(['whoami', '--json'], childEnv(true));
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const data = JSON.parse(stdout);
  expect(data.user_id).toBe(SESSION_USER.user_id);
  expect(data.url).toBe(`http://127.0.0.1:${envApi!.port}`);
  expect(storedRequests).toEqual([]);
});

test('`--host self` keeps probing the named stored host', async () => {
  const { code, stdout, stderr } = await runCli(
    ['whoami', '--json', '--host', 'self'],
    childEnv(true),
  );
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const data = JSON.parse(stdout);
  expect(data.user_id).toBe(OWN_USER.user_id);
  expect(data.url).toBe(`http://127.0.0.1:${storedApi!.port}`);
  expect(envRequests).toEqual([]);
});
