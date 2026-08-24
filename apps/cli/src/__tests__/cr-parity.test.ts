import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_cr';
const CR_ID = '11111111-2222-4333-8444-555555555555';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let mergeable = true;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_cr',
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

function changeRequest() {
  return {
    cr_id: CR_ID,
    account_id: 'account_1',
    project_id: PROJECT,
    number: 4,
    title: 'Rename the flag',
    description: '',
    base_ref: 'main',
    head_ref: 'agent/rename-flag',
    status: 'open',
    head_commit_sha: 'aaaaaaa1111',
    base_commit_sha: 'bbbbbbb2222',
    origin_session_id: 'sess_1',
    created_by: 'user_1',
    merged_at: null,
    merged_by: null,
    merge_commit_sha: null,
    closed_at: null,
    closed_by: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const base = `/v1/projects/${PROJECT}`;

      if (url.pathname === `${base}/change-requests` && req.method === 'GET') {
        return Response.json({ change_requests: [changeRequest()] });
      }
      if (url.pathname === `${base}/change-requests/${CR_ID}` && req.method === 'GET') {
        return Response.json({ change_request: changeRequest() });
      }
      if (url.pathname === `${base}/change-requests/${CR_ID}/merge-preview`) {
        return Response.json(
          mergeable
            ? {
                base_sha: 'b',
                head_sha: 'h',
                merge_base: 'm',
                can_fast_forward: true,
                can_merge: true,
                conflicts: [],
                is_up_to_date: false,
              }
            : {
                base_sha: 'b',
                head_sha: 'h',
                merge_base: 'm',
                can_fast_forward: false,
                can_merge: false,
                conflicts: ['src/a.ts', 'src/b.ts'],
                is_up_to_date: false,
              },
        );
      }
      if (url.pathname === `${base}/change-requests/${CR_ID}/request-changes` && req.method === 'POST') {
        if (!(body as { feedback?: string })?.feedback) {
          return Response.json({ error: 'feedback is required' }, { status: 400 });
        }
        return Response.json({ change_request: changeRequest(), delivering: true });
      }
      if (url.pathname === `${base}/version-diff`) {
        if (url.searchParams.get('from') === 'empty') {
          return Response.json({
            from: 'empty',
            into: 'main',
            from_sha: 'x',
            into_sha: 'x',
            merge_base: 'x',
            files_changed: 0,
            additions: 0,
            deletions: 0,
            is_up_to_date: true,
            is_same_ref: false,
          });
        }
        return Response.json({
          from: url.searchParams.get('from'),
          into: url.searchParams.get('into'),
          from_sha: 'h',
          into_sha: 'b',
          merge_base: 'm',
          files_changed: 3,
          additions: 42,
          deletions: 7,
          is_up_to_date: false,
          is_same_ref: false,
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'KORTIX_BRANCH_NAME', 'KORTIX_HEAD_REF', 'KORTIX_SESSION_ID', 'BASH_ENV']) {
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

describe('kortix cr — review parity', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-cr-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    mergeable = true;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents the three new subcommands', async () => {
    const r = await runCli(['cr', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of ['merge-preview <cr>', 'request-changes <cr>', 'version-diff --from', 'project.review.act']) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('merge-preview on a clean CR exits 0 and says it merges', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'merge-preview', CR_ID, '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/projects/${PROJECT}/change-requests/${CR_ID}`,
      `/v1/projects/${PROJECT}/change-requests/${CR_ID}/merge-preview`,
    ]);
    expect(r.stdout).toContain('Mergeable cleanly');
    expect(r.stdout).toContain('fast-forward');
  });

  test('merge-preview on a conflicted CR lists the files and exits 1', async () => {
    const config = writeConfig(startServer());
    mergeable = false;
    const r = await runCli(['cr', 'merge-preview', '4', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Conflicts in 2 files');
    expect(r.stdout).toContain('src/a.ts');
    expect(r.stdout).toContain('src/b.ts');
  });

  test('merge-preview --json emits the raw preview', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'merge-preview', CR_ID, '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).can_merge).toBe(true);
  });

  test('request-changes POSTs {feedback} and reports delivery', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'request-changes', CR_ID, '--message', 'Rename it first', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/change-requests/${CR_ID}/request-changes`,
      body: { feedback: 'Rename it first' },
    });
    expect(r.stdout).toContain('Delivering to the agent');
    expect(r.stdout).toContain('CR #4');
  });

  test('request-changes without --message exits 2 and never calls the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'request-changes', CR_ID, '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--message');
    expect(calls).toEqual([]);
  });

  test('version-diff sends from/into and prints the summary', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'version-diff', '--from', 'feature/x', '--into', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `/v1/projects/${PROJECT}/version-diff?from=feature%2Fx&into=main`,
      body: null,
    });
    expect(r.stdout).toContain('3 files');
    expect(r.stdout).toContain('+42');
    expect(r.stdout).toContain('-7');
  });

  test('version-diff says so when there is nothing to propose', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'version-diff', '--from', 'empty', '--into', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No changes');
  });

  test('version-diff without --into exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'version-diff', '--from', 'x', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--from <version> and --into <version>');
    expect(calls).toEqual([]);
  });

  test('an unknown CR number reports it without hitting the write route', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'request-changes', '99', '--message', 'x', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No CR #99');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
