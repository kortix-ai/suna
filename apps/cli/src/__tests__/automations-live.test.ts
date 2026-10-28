import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const LIST = `/v1/projects/${PROJECT}/automations`;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: { method: string; path: string; body: unknown }[] = [];

const DECLARED = {
  id: 'nightly', origin: 'declared', name: 'Nightly digest', prompt: 'Digest', agent: 'default', state: 'active',
  source: { type: 'schedule', cron: '0 0 9 * * *', every: null, at: null, timezone: 'UTC' },
  target: { kind: 'agent', agent: 'default' },
  next_fire_at: '2026-10-29T09:00:00.000Z', last_fired_at: null, last_status: null, last_error: null,
};
const WOKEN = {
  id: 'automation.0123456789ab', origin: 'runtime', name: null, prompt: 'CR merged', agent: 'kortix', state: 'active',
  source: { type: 'change_request', cr_id: 'cr-1', base: null },
  target: { kind: 'session', session_id: SESSION, session_name: 'Ship it' },
  next_fire_at: null, last_fired_at: null, last_status: null, last_error: null,
};

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === LIST && req.method === 'GET') {
        return Response.json({ automations: [DECLARED, WOKEN], triggers_paused: false, account_automations_paused: false, errors: [] });
      }
      if (url.pathname === LIST && req.method === 'POST') return Response.json(WOKEN, { status: 201 });
      if (url.pathname === `${LIST}/${WOKEN.id}` && req.method === 'PATCH') return Response.json({ ...WOKEN, state: 'paused' });
      if (url.pathname === `${LIST}/${WOKEN.id}` && req.method === 'DELETE') return Response.json({ ok: true });
      if (url.pathname === `${LIST}/${WOKEN.id}/run` && req.method === 'POST') return Response.json(WOKEN, { status: 202 });
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

async function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const apiUrl = startServer();
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

describe('kortix automations', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-automations-'));
    calls = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  test('ls lists kortix.yaml and runtime automations with source and target', async () => {
    const r = await runCli(['automations', 'ls']);
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ method: 'GET', path: LIST, body: null }]);
    expect(r.stdout).toContain('nightly');
    expect(r.stdout).toContain('kortix.yaml');
    expect(r.stdout).toContain('cron 0 0 9 * * *');
    expect(r.stdout).toContain('agent default');
    expect(r.stdout).toContain('automation.0123456789ab');
    expect(r.stdout).toContain('runtime');
    expect(r.stdout).toContain('cr merged cr-1');
    expect(r.stdout).toContain('session Ship it');
  }, 60_000);

  test('add --on cr-merged wakes this session by default', async () => {
    const r = await runCli(['automations', 'add', 'CR merged: check the deploy', '--on', 'cr-merged', '--cr', 'cr-1', '--json']);
    expect(r.code).toBe(0);
    expect(calls).toEqual([{
      method: 'POST', path: LIST,
      body: { prompt: 'CR merged: check the deploy', source: { type: 'change_request', cr_id: 'cr-1' }, target: { session_id: SESSION } },
    }]);
    expect(JSON.parse(r.stdout).id).toBe(WOKEN.id);
  }, 60_000);

  test('add with a schedule flag and --agent starts a new agent session per fire', async () => {
    const r = await runCli(['automations', 'add', 'Digest', '--every', '1h', '--agent', 'writer', '--name', 'digest']);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST', path: LIST,
      body: { prompt: 'Digest', name: 'digest', source: { type: 'schedule', every: '1h' }, target: { agent: 'writer' } },
    });
  }, 60_000);

  test('add --on webhook requires --secret-env', async () => {
    const r = await runCli(['automations', 'add', 'Build', '--on', 'webhook']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--secret-env');
    expect(calls).toEqual([]);
  }, 60_000);

  test('pause, run and rm address a runtime id through /automations', async () => {
    expect((await runCli(['automations', 'pause', WOKEN.id])).code).toBe(0);
    expect((await runCli(['automations', 'run', WOKEN.id])).code).toBe(0);
    expect((await runCli(['automations', 'rm', WOKEN.id])).code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${LIST}/${WOKEN.id}`,
      `POST ${LIST}/${WOKEN.id}/run`,
      `DELETE ${LIST}/${WOKEN.id}`,
    ]);
    expect(calls[0]!.body).toEqual({ enabled: false });
  }, 60_000);

  test('help names the aliases', async () => {
    const r = await runCli(['automations', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kortix triggers');
    expect(r.stdout).toContain('kortix loop');
  }, 60_000);
});
