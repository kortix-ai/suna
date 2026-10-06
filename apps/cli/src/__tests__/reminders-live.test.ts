import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const BASE = `/v1/projects/${PROJECT}/sessions/${SESSION}/reminders`;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];

const REMINDER = {
  id: 'reminder.0123456789ab',
  session_id: SESSION,
  name: null,
  prompt: 'Did the email arrive?',
  every: '1h',
  every_seconds: 3600,
  cron: null,
  timezone: 'UTC',
  at: null,
  state: 'active',
  next_fire_at: '2026-09-29T12:00:00.000Z',
  last_fired_at: null,
  last_status: null,
  last_error: null,
  created_by: 'user_1',
  created_at: '2026-09-28T12:00:00.000Z',
};

const DONE = { ...REMINDER, id: 'reminder.done00000000', every: null, every_seconds: null, state: 'done', next_fire_at: null, last_fired_at: '2026-09-29T08:30:12.000Z', last_status: 'fired' };
const NAMED = { ...REMINDER, id: 'reminder.named0000000', name: 'standup' };

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname, body, auth: req.headers.get('authorization') });
      if (url.pathname === BASE && req.method === 'POST') {
        if ((body as { prompt?: string }).prompt === 'FLAG_OFF') {
          return Response.json(
            { error: 'Reminders is not enabled for this project. Enable it in Settings → Feature flags.', code: 'feature_disabled', feature: 'reminders' },
            { status: 403 },
          );
        }
        if ((body as { every?: string }).every === '1m') {
          return Response.json({ error: 'every must be at least 5m' }, { status: 400 });
        }
        return Response.json(REMINDER, { status: 201 });
      }
      if (url.pathname === BASE && req.method === 'GET') return Response.json({ reminders: [REMINDER, DONE, NAMED] });
      if (url.pathname === `${BASE}/${DONE.id}` && req.method === 'PATCH') return Response.json(DONE);
      if (url.pathname === `${BASE}/${REMINDER.id}` && req.method === 'PATCH') {
        const enabled = (body as { enabled: boolean }).enabled;
        return Response.json({ ...REMINDER, state: enabled ? 'active' : 'paused' });
      }
      if (url.pathname === `${BASE}/${REMINDER.id}` && req.method === 'DELETE') return Response.json({ ok: true });
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

/** Run the real CLI the way an agent inside a session does: env token, project and session. */
async function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const apiUrl = startServerOnce();
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: join(tmp, 'missing-config.json'),
    KORTIX_TOKEN: 'kortix_pat_session_token',
    KORTIX_API_URL: apiUrl,
    KORTIX_PROJECT_ID: PROJECT,
    KORTIX_SESSION_ID: SESSION,
    BASH_ENV: undefined,
    ...extraEnv,
  };
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

let apiUrl: string | null = null;
function startServerOnce(): string {
  if (!apiUrl) apiUrl = startServer();
  return apiUrl;
}

describe('kortix reminders — inside a session', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-reminders-'));
    calls = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    apiUrl = null;
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  test('remind posts the prompt and schedule to the own session and prints the id', async () => {
    const r = await runCli(['remind', 'Did the email arrive?', '--in', '24h', '--every', '1h']);
    expect(r.stderr).not.toContain('✗');
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: BASE,
        body: { prompt: 'Did the email arrive?', in: '24h', every: '1h' },
        auth: 'Bearer kortix_pat_session_token',
      },
    ]);
    expect(r.stdout).toContain('Reminder set reminder.0123456789ab');
    expect(r.stdout).toContain('every 1h');
    expect(r.stdout).toContain('kortix reminders rm reminder.0123456789ab');
  }, 60_000);

  test('reminders add --cron --timezone --name --json maps every flag', async () => {
    const r = await runCli(['reminders', 'add', 'Standup', '--cron', '0 0 9 * * 1-5', '--tz', 'Europe/Berlin', '--name', 'standup', '--json']);
    expect(r.code).toBe(0);
    expect(calls[0]?.body).toEqual({ prompt: 'Standup', cron: '0 0 9 * * 1-5', timezone: 'Europe/Berlin', name: 'standup' });
    expect(JSON.parse(r.stdout).id).toBe('reminder.0123456789ab');
  }, 60_000);

  test('ls, pause, resume, rm hit the reminder routes', async () => {
    const ls = await runCli(['reminders', 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('reminder.0123456789ab');
    expect(ls.stdout).toContain('Did the email arrive?');
    // LAST FIRED: a fired reminder shows when, a never-fired one shows a dash.
    expect(ls.stdout).toContain('LAST FIRED');
    expect(ls.stdout).toContain('2026-09-29 08:30 UTC');

    const paused = await runCli(['reminders', 'pause', 'reminder.0123456789ab']);
    expect(paused.stdout).toContain('state   paused');
    const resumed = await runCli(['reminders', 'resume', 'reminder.0123456789ab']);
    expect(resumed.stdout).toContain('state   active');
    const removed = await runCli(['reminders', 'stop', 'reminder.0123456789ab']);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain('Removed reminder.0123456789ab');

    expect(calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`)).toEqual([
      `GET ${BASE} null`,
      `PATCH ${BASE}/reminder.0123456789ab {"enabled":false}`,
      `PATCH ${BASE}/reminder.0123456789ab {"enabled":true}`,
      `DELETE ${BASE}/reminder.0123456789ab null`,
    ]);
  }, 60_000);

  test('a named reminder lists its prompt in TEXT and its name in NAME', async () => {
    const ls = await runCli(['reminders', 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('NAME');
    const row = ls.stdout.split('\n').find((l) => l.includes('reminder.named0000000')) ?? '';
    expect(row).toContain('standup');
    expect(row).toContain('Did the email arrive?');
  }, 60_000);

  test('resume of a fired one-shot says it stays done instead of claiming it resumed', async () => {
    const r = await runCli(['reminders', 'resume', DONE.id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('state   done');
    expect(r.stdout).toContain('last    2026-09-29 08:30 UTC');
    expect(r.stdout).not.toContain('Resumed');
    expect(r.stdout).toContain('already fired and stays done');
  }, 60_000);

  test('an API validation error exits 1 with the server message', async () => {
    const r = await runCli(['remind', 'x', '--every', '1m']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('every must be at least 5m');
  }, 60_000);

  test('flag off: the server message plus the command that turns reminders on, exit 1', async () => {
    const r = await runCli(['remind', 'FLAG_OFF', '--in', '1h']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Reminders is not enabled for this project');
    expect(r.stderr).toContain('kortix projects features enable reminders');
  }, 60_000);

  test('no session anywhere and no prompt are usage errors (exit 2), with no request', async () => {
    const noSession = await runCli(['remind', 'x', '--in', '1h'], { KORTIX_SESSION_ID: undefined });
    expect(noSession.code).toBe(2);
    expect(noSession.stderr).toContain('Pass --session <id>');
    const noPrompt = await runCli(['reminders', 'add', '--in', '1h']);
    expect(noPrompt.code).toBe(2);
    expect(calls).toHaveLength(0);
  }, 60_000);
});
