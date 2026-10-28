import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// P8.3: the CLI reads the stored session log, never the v1 transcript
// (`GET …/transcript`), whatever the API answers. A credential that cannot
// read the project detail (a session-bound token) used to send the stopped
// session's read to the v1 route.
const projectId = '00000000-0000-4000-a000-000000000222';
const sessionId = '00000000-0000-4000-a000-000000000333';
const entry = resolve(import.meta.dir, '../index.ts');
const root = mkdtempSync(join(tmpdir(), 'sessions-no-v1-'));
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const row = {
  session_id: sessionId,
  project_id: projectId,
  account_id: 'synthetic-account',
  name: 'Synthetic session',
  agent_name: 'default',
  status: 'stopped',
  opencode_session_id: 'ses_synthetic_root',
  runtime_session_id: 'ses_synthetic_root',
  created_at: '2026-10-28T00:00:00Z',
  updated_at: '2026-10-28T00:00:00Z',
};

const logAnswers = {
  'a 404 coded session_log_missing': () =>
    Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 }),
  'a 404 without a code': () => Response.json({ error: 'No session log for this session' }, { status: 404 }),
};

const commands: Array<[string, string[]]> = [
  ['sessions log', ['sessions', 'log', sessionId, '--project', projectId]],
  ['sessions attachments', ['sessions', 'attachments', sessionId, '--project', projectId]],
  ['sessions digest', ['sessions', 'digest', '--project', projectId, '--all', '--json']],
];

for (const [name, args] of commands) {
  for (const [answer, log] of Object.entries(logAnswers)) {
    test(`${name}: GET …/log answers ${answer}, the project detail is refused: no GET …/transcript`, async () => {
      const { paths } = await run(args, log);
      expect(paths.some((path) => path.endsWith('/log'))).toBe(true);
      expect(paths.filter((path) => path.includes('/transcript'))).toEqual([]);
    });
  }
}

async function run(args: string[], log: () => Response) {
  const paths: string[] = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/v1/accounts/me') return Response.json({ accounts: [] });
      if (path === `/v1/projects/${projectId}/sessions`) return Response.json([row]);
      if (path === `/v1/projects/${projectId}/sessions/${sessionId}`) return Response.json(row);
      if (path === `/v1/projects/${projectId}/sessions/${sessionId}/log`) return log();
      // A session-bound token cannot read the project detail.
      if (path === `/v1/projects/${projectId}/detail`) return Response.json({ error: 'Forbidden' }, { status: 403 });
      if (path === `/v1/projects/${projectId}/sessions/${sessionId}/transcript`) {
        return Response.json({ available: true, reason: null, source: 'mirror', complete: true, message_count: 0, messages: [] });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: {
    url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token',
    default_project: { project_id: projectId, account_id: 'synthetic-account', name: 'Synthetic project' },
  } } }));
  const env: Record<string, string | undefined> = { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1' };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) delete env[key];
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, paths };
}
