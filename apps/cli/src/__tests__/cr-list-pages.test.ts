import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// KRTX-2316: `GET /change-requests` returns one page (50 by default) and a
// `next_cursor`. `kortix cr ls` still lists every change request, and a CR
// number resolves on any page. An older API sends one full list and no cursor.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = 'proj_pages';
const TOTAL = 120;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let paths: string[] = [];
/** false: the API before KRTX-2316 (no default page, no cursor). */
let paged = true;

function changeRequest(number: number) {
  return {
    cr_id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    account_id: 'account_1',
    project_id: PROJECT,
    number,
    title: `Change ${number}`,
    description: '',
    base_ref: 'main',
    head_ref: `branch-${number}`,
    status: 'open',
    head_commit_sha: null,
    base_commit_sha: null,
    origin_session_id: null,
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
    fetch: (req) => {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      if (url.pathname !== `/v1/projects/${PROJECT}/change-requests`) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const all = Array.from({ length: TOTAL }, (_, i) => changeRequest(TOTAL - i));
      if (!paged) return Response.json({ change_requests: all });
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (limit > 500) return Response.json({ error: 'limit' }, { status: 400 });
      const cursor = url.searchParams.get('cursor');
      const rest = cursor ? all.filter((cr) => cr.number < Number(cursor)) : all;
      const page = rest.slice(0, limit);
      return Response.json({
        change_requests: page,
        next_cursor: rest.length > limit ? String(page[page.length - 1].number) : null,
      });
    },
  });
  return `http://127.0.0.1:${server.port}`;
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
          token: 'tok_pages',
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
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'KORTIX_BRANCH_NAME',
    'KORTIX_HEAD_REF',
    'KORTIX_SESSION_ID',
    'BASH_ENV',
  ]) {
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

describe('kortix cr — a list longer than one page', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-cr-pages-'));
    paths = [];
    paged = true;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('ls --json lists every change request, page by page', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'ls', '--status', 'all', '--json', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const numbers = JSON.parse(r.stdout).change_requests.map((cr: { number: number }) => cr.number);
    expect(numbers).toEqual(Array.from({ length: TOTAL }, (_, i) => TOTAL - i));
    expect(paths).toEqual([
      `/v1/projects/${PROJECT}/change-requests?status=all`,
      `/v1/projects/${PROJECT}/change-requests?status=all&limit=500&cursor=71`,
    ]);
  });

  test('ls prints the whole count', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${TOTAL} change requests`);
    expect(r.stdout).toContain('#1 ');
  });

  test('a CR number past the first page resolves, and the walk stops there', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'show', '60', '--json', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).change_request.number).toBe(60);
    // `show` also asks for the merge preview of an open CR: count list reads only.
    expect(paths.filter((path) => path.includes('/change-requests?'))).toEqual([
      `/v1/projects/${PROJECT}/change-requests?status=all`,
      `/v1/projects/${PROJECT}/change-requests?status=all&limit=500&cursor=71`,
    ]);
  });

  test('an older API that sends one full list is read once', async () => {
    paged = false;
    const config = writeConfig(startServer());
    const r = await runCli(['cr', 'ls', '--status', 'all', '--json', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).change_requests).toHaveLength(TOTAL);
    expect(paths).toEqual([`/v1/projects/${PROJECT}/change-requests?status=all`]);
  });
});
