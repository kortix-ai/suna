import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

// Black-box reproduction of the in-sandbox agent case: the real `kortix`
// process, a real HTTP API, a real `.kortix/link.json`, and a real minted
// agent token in the environment.
//
// The original report — `kortix sessions restart "$KORTIX_SESSION_ID"` from
// inside a session — printed:
//
//   host cloud (https://api.kortix.com, not logged in) · account … · session …
//     ✗  You don't have permission to perform this action (project.session.read).
//
// Both halves were unusable: the CLI was authenticated (it just made an
// authenticated request), and the denial never said WHICH identity was refused.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');

const PROJECT_ID = '508bccdd-1edb-4c61-877b-164aceac20e2';
const SESSION_ID = 'ea985b87-d12c-4ba4-aa12-ee0711dab6f6';
const ACCOUNT_ID = '3b1fc472-a90e-404f-823f-ca42f6b32e4d';
const AGENT_TOKEN = 'kortix_pat_minted_for_osp_vision_route_agent';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: string[] = [];

/** Stand-in for the Kortix API: it knows the token's identity, and it refuses
 *  the session read exactly as production does for an agent without the
 *  `project.session.read` grant. */
function startApi() {
  requests = [];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (req.headers.get('authorization') !== `Bearer ${AGENT_TOKEN}`) {
        return Response.json({ error: 'unauthenticated' }, { status: 401 });
      }
      if (url.pathname === '/v1/accounts/me') {
        return Response.json({
          user_id: 'user_123',
          email: 'owner@example.test',
          token_context: {
            auth_type: 'pat',
            project_id: PROJECT_ID,
            session_id: SESSION_ID,
            agent: 'osp-vision-route-agent',
            connectors: [],
            kortix_cli: ['project.secret.read', 'project.secret.write'],
          },
          accounts: [
            { account_id: ACCOUNT_ID, slug: '3b1fc472', name: 'Essentia', role: 'owner' },
          ],
        });
      }
      if (url.pathname.startsWith(`/v1/projects/${PROJECT_ID}/sessions`)) {
        return Response.json(
          { error: "You don't have permission to perform this action (project.session.read)." },
          { status: 403 },
        );
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

/** A sandbox workspace: linked directory, plus a `cloud` host that was never
 *  logged in — the credential arrives through the environment instead. */
function seedWorkspace(apiBase: string): void {
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(
    join(tmp, '.kortix', 'link.json'),
    JSON.stringify({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      host: 'cloud',
      host_url: apiBase,
      linked_at: '2026-07-13T17:06:24.828Z',
    }),
  );
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({
      active: 'cloud',
      hosts: {
        cloud: {
          url: apiBase,
          token: '',
          user_id: '',
          user_email: '',
          account_id: '',
          logged_in_at: '',
        },
      },
    }),
  );
}

async function runCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
      // What the platform injects into a running session.
      KORTIX_API_URL: `http://127.0.0.1:${server!.port}`,
      KORTIX_CLI_TOKEN: AGENT_TOKEN,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_SESSION_ID: SESSION_ID,
    },
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
  tmp = mkdtempSync(join(tmpdir(), 'kortix-agent-identity-'));
  server = startApi();
  seedWorkspace(`http://127.0.0.1:${server.port}`);
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

test('a refused session read reports the CLI as authenticated and names the agent', async () => {
  const first = await runCli(['sessions', 'restart', SESSION_ID]);

  // 1. The standing context line no longer contradicts the request it just made.
  expect(first.stderr).not.toContain('not logged in');
  expect(first.stderr).toContain('authenticated (session token)');
  // The cwd link still supplies account + project.
  expect(first.stderr).toContain(`account ${ACCOUNT_ID.slice(0, 8)}`);
  expect(first.stderr).toContain(`project ${PROJECT_ID.slice(0, 8)}`);

  // 2. The denial still names the action…
  expect(first.stderr).toContain('project.session.read');
  // …and now also names the identity that was refused, its grant, and the fix.
  expect(first.stderr).toContain('session token · agent osp-vision-route-agent');
  expect(first.stderr).toContain('project.secret.read, project.secret.write');
  expect(first.stderr).toContain('agents.osp-vision-route-agent.kortix_cli');
  expect(first.code).toBe(1);

  // 3. The identity was resolved once and cached, so the NEXT command names the
  //    agent in its standing line without any further /accounts/me call.
  const meCallsAfterFirst = requests.filter((r) => r.endsWith('/v1/accounts/me')).length;
  const second = await runCli(['sessions', 'restart', SESSION_ID]);
  expect(second.stderr).toContain('agent osp-vision-route-agent');
  expect(requests.filter((r) => r.endsWith('/v1/accounts/me')).length).toBe(meCallsAfterFirst);
});

test('the bare landing screen shows the agent row instead of a logged-out host', async () => {
  await runCli(['sessions', 'restart', SESSION_ID]); // warms the identity cache
  const landing = await runCli([]);

  expect(landing.stdout).toContain('osp-vision-route-agent');
  expect(landing.stdout).not.toContain('not logged in');
  expect(landing.stdout).toContain('kortix whoami --token-only');
});
