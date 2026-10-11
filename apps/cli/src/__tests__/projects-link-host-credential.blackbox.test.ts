import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Black-box reproduction of the dogfood report: `kortix projects link <id>
// --host <host>` inside a sandbox 403'd cross-project because the command
// authenticated with the ambient session-scoped token instead of the named
// host's stored personal access key — the same key every sibling subcommand
// (`projects use/info`) already uses for `--host`. The named host's key is
// valid (the same GET succeeds with it), so the link was unachievable through
// the CLI even though the credential was fine.
//
// This test spawns the real CLI process against a fixture API that mirrors
// production's refusal: the GET succeeds only for the named host's token and
// 403s for the session token, exactly like a cross-project read.

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

// The project the session token is scoped to (the sandbox's own project) and
// the foreign project the user is linking — the fixture refuses the latter
// for the session token, as production does for a cross-project read.
const SESSION_PROJECT_ID = '5a1e0c0a-0000-4000-8000-000000000001';
const TARGET_PROJECT_ID = '5a1e0c0a-0000-4000-8000-000000000002';
const ACCOUNT_ID = '5a1e0c0c-0000-4000-8000-00000000000c';
const HOST_NAME = 'remote';
const SESSION_TOKEN = 'kortix_pat_session_scoped';
const HOST_TOKEN = 'kortix_pat_named_host_key';

interface Request {
  method: string;
  path: string;
  authorization: string | null;
}

let tmp: string;
let apiBase = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Request[] = [];

function startApi() {
  requests = [];
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get('authorization'),
      });
      if (url.pathname === `/v1/projects/${TARGET_PROJECT_ID}`) {
        if (req.headers.get('authorization') === `Bearer ${HOST_TOKEN}`) {
          return Response.json({
            project_id: TARGET_PROJECT_ID,
            account_id: ACCOUNT_ID,
            name: 'Foreign Project',
          });
        }
        // Production's cross-project refusal for the session-scoped principal.
        return Response.json(
          { error: `Project ${TARGET_PROJECT_ID} does not belong to this session's project` },
          { status: 403 },
        );
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

function seedWorkspace(): void {
  // `projects link` refuses directories without a `.kortix/` scaffold.
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({
      active: HOST_NAME,
      hosts: {
        [HOST_NAME]: {
          url: apiBase,
          token: HOST_TOKEN,
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: ACCOUNT_ID,
          logged_in_at: '2026-01-01T00:00:00.000Z',
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
      // What the platform injects into a running session: the ambient
      // session-scoped token the command must NOT fall back to.
      KORTIX_API_URL: apiBase,
      KORTIX_TOKEN: SESSION_TOKEN,
      KORTIX_PROJECT_ID: SESSION_PROJECT_ID,
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
  tmp = mkdtempSync(join(tmpdir(), 'kortix-link-host-'));
  server = startApi();
  apiBase = `http://127.0.0.1:${server.port}`;
  seedWorkspace();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

test('projects link --host authenticates with the named host key, not the session token', async () => {
  const run = await runCli(['projects', 'link', TARGET_PROJECT_ID, '--host', HOST_NAME]);

  const linkGet = requests.find(
    (r) => r.method === 'GET' && r.path === `/v1/projects/${TARGET_PROJECT_ID}`,
  );
  expect(linkGet, 'the project lookup must reach the API').toBeDefined();
  // The named host's stored key serves the request — never the ambient
  // session-scoped token, which production 403s as cross-project.
  expect(linkGet?.authorization).toBe(`Bearer ${HOST_TOKEN}`);
  expect(run.code).toBe(0);
  // A word-bounded 403: the stub's random port (e.g. 40403) is printed too.
  expect(run.stderr).not.toMatch(/\b403\b/);

  const link = JSON.parse(readFileSync(join(tmp, '.kortix', 'link.json'), 'utf8'));
  expect(link.project_id).toBe(TARGET_PROJECT_ID);
  expect(link.host).toBe(HOST_NAME);
  expect(link.host_url).toBe(apiBase);
});
