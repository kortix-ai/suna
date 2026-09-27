// `kortix sessions status` prints one row per session: status dot, the short
// session id (first dash segment), the label, and how long ago it last moved.
// The age reads as a relative count at every range — a 45-day-old session
// prints "45d ago", never a calendar date.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = 'proj_status';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let paths: string[] = [];

function session(id: string, name: string, ageMs: number) {
  const at = new Date(Date.now() - ageMs).toISOString();
  return {
    session_id: id,
    name,
    status: 'stopped',
    agent_name: 'default',
    branch_name: `kortix/${name}`,
    created_at: at,
    updated_at: at,
  };
}

function startServer(sessions: unknown[]): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      paths.push(url.pathname);
      if (url.pathname === `/v1/projects/${PROJECT}/sessions`) return Response.json(sessions);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_status',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

async function runCli(args: string[], configFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix sessions status', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-sessions-status-'));
    paths = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--all prints the short id and a relative age for every session', async () => {
    const config = writeConfig(
      startServer([
        session('aaaa1111-0000-4000-8000-000000000001', 'fresh', 10 * 1000),
        session('bbbb2222-0000-4000-8000-000000000002', 'minutes', 5 * MINUTE),
        session('cccc3333-0000-4000-8000-000000000003', 'hours', 3 * HOUR),
        session('dddd4444-0000-4000-8000-000000000004', 'weeks', 45 * DAY),
      ]),
    );
    const r = await runCli(['sessions', 'status', '--all', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(paths).toEqual([`/v1/projects/${PROJECT}/sessions`]);

    const row = (name: string) => r.stdout.split('\n').find((line) => line.includes(` ${name} `)) ?? '';
    expect(row('fresh')).toMatch(/aaaa1111\s+fresh\s+.*just now$/);
    expect(row('minutes')).toMatch(/bbbb2222\s+minutes\s+.*5m ago$/);
    expect(row('hours')).toMatch(/cccc3333\s+hours\s+.*3h ago$/);
    expect(row('weeks')).toMatch(/dddd4444\s+weeks\s+.*45d ago$/);
    expect(r.stdout).not.toContain('-0000-');
  });
});
