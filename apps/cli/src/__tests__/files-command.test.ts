import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFiles } from '../commands/files.ts';
import { stripAnsi } from '../style.ts';

// Characterization for `kortix files` — the nine subcommands against a scripted
// API, written before the command's dispatcher was restructured so the table
// shapes and the exact requests are pinned by test, not by reading.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string }> = [];

/** The one route table every test tweaks. Return a Response or undefined to 404. */
let route: ((url: URL, method: string) => Response | undefined) | null = null;

const COMMIT = {
  hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  short_hash: 'a1b2c3d',
  parents: [],
  author_name: 'Kortix Agent',
  author_email: 'agent@example.test',
  authored_at: '2026-08-01T00:00:00.000Z',
  committer_name: 'Kortix Agent',
  committer_email: 'agent@example.test',
  committed_at: '2026-08-01T00:00:00.000Z',
  subject: 'Add the reader',
  body: '',
};

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function mockApi(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? 'GET' });
    const hit = route?.(url, init?.method ?? 'GET');
    if (hit) return hit;
    return Response.json({ error: 'no route' }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmp = mkdtempSync(join(tmpdir(), 'kortix-files-'));
  originalCwd = process.cwd();
  process.chdir(tmp);
  process.env.KORTIX_PROJECT_ID = 'proj_files';
  writeConfig();
  stdout = '';
  stderr = '';
  requests = [];
  route = null;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = (chunk: unknown) => ((stdout += String(chunk)), true);
  stderrStream.write = (chunk: unknown) => ((stderr += String(chunk)), true);
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = ORIGINAL_STDOUT_WRITE as unknown as (chunk: unknown) => boolean;
  stderrStream.write = ORIGINAL_STDERR_WRITE as unknown as (chunk: unknown) => boolean;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix files — the nine subcommands', () => {
  test('ls lists files under a path and sizes them', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/files') return undefined;
      expect(url.search).toContain('path=src%2F');
      return Response.json([
        { path: 'src/a.ts', type: 'file', size: 42 },
        { path: 'src/b.ts', type: 'file', size: null },
      ]);
    };
    const code = await runFiles(['ls', 'src/']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('42B');
    expect(out).toContain('2 files');
  });

  test('ls --json emits the raw API payload', async () => {
    const items = [{ path: 'README.md', type: 'file', size: 7 }];
    route = () => Response.json(items);
    const code = await runFiles(['ls', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(items);
  });

  test('cat prints the file content, adding one trailing newline', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/files/content') return undefined;
      expect(url.search).toContain('path=README.md');
      return Response.json({ path: 'README.md', ref: 'main', content: 'hello' });
    };
    const code = await runFiles(['cat', 'README.md']);
    expect(code).toBe(0);
    expect(stdout).toBe('hello\n');
  });

  test('search passes the query, --content and --limit; rows carry path:line', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/files/search') return undefined;
      expect(url.search).toContain('q=needle');
      expect(url.search).toContain('content=1');
      expect(url.search).toContain('limit=5');
      return Response.json({
        results: [
          { path: 'src/a.ts', line_number: 3, line_text: '  const needle = 1;  ' },
          { path: 'dir/b.ts' },
        ],
      });
    };
    const code = await runFiles(['search', 'needle', '--content', '--limit', '5']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('src/a.ts:3');
    expect(out).toContain('const needle = 1;');
    expect(out).toContain('dir/b.ts');
    expect(out).toContain('2 matches');
  });

  test('history lists a file commit list with --limit on the wire', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/files/history') return undefined;
      expect(url.search).toContain('path=README.md');
      expect(url.search).toContain('limit=2');
      return Response.json({ commits: [COMMIT], hasMore: true });
    };
    const code = await runFiles(['history', 'README.md', '--limit', '2']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('a1b2c3d');
    expect(out).toContain('Add the reader');
    expect(out).toContain('more available');
  });

  test('branches opts back into the full remote listing', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/branches') return undefined;
      expect(url.search).toContain('include_session_branches=true');
      expect(url.search).toContain('limit=2000');
      return Response.json({
        default_branch: 'main',
        branches: [
          {
            name: 'main',
            is_default: true,
            tip: COMMIT.hash,
            tip_short: 'a1b2c3d',
            subject: 'Add the reader',
            committer_name: 'Kortix Agent',
            committed_at: COMMIT.committed_at,
            ahead: null,
            behind: null,
          },
          {
            name: 'feature',
            is_default: false,
            tip: COMMIT.hash,
            tip_short: 'a1b2c3d',
            subject: 'Wip',
            committer_name: 'Kortix Agent',
            committed_at: COMMIT.committed_at,
            ahead: 2,
            behind: 1,
          },
        ],
      });
    };
    const code = await runFiles(['branches']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('main');
    expect(out).toContain('feature');
    expect(out).toContain('2/1');
    expect(out).toContain('default: main');
  });

  test('commits lists commits, scoped by --path', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/commits') return undefined;
      expect(url.search).toContain('path=src');
      return Response.json({ commits: [COMMIT], hasMore: false });
    };
    const code = await runFiles(['commits', '--path', 'src']);
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('Add the reader');
  });

  test('show prints one commit with its changed files', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/commits/a1b2c3d') return undefined;
      return Response.json({
        ...COMMIT,
        files: [
          { path: 'src/reader.ts', old_path: null, status: 'added', additions: 10, deletions: 0 },
          { path: 'src/old.ts', old_path: 'src/new.ts', status: 'renamed', additions: 1, deletions: 1 },
        ],
      });
    };
    const code = await runFiles(['show', 'a1b2c3d']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('commit a1b2c3d4e5f6');
    expect(out).toContain('Add the reader');
    expect(out).toContain('A src/reader.ts');
    expect(out).toContain('src/new.ts → src/old.ts');
    expect(out).toContain('2 files changed');
  });

  test('diff prints the unified patch verbatim', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/commits/a1b2c3d/diff') return undefined;
      expect(url.search).toContain('path=src');
      return Response.json({ patch: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n' });
    };
    const code = await runFiles(['diff', 'a1b2c3d', '--path', 'src']);
    expect(code).toBe(0);
    expect(stdout).toBe('--- a/f\n+++ b/f\n@@ -1 +1 @@\n');
  });

  test('download writes the zip to -o and reports it', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_files/files/archive') return undefined;
      return new Response(new Blob([new Uint8Array([0x50, 0x4b, 1, 2, 3])]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    };
    const code = await runFiles(['download', '-o', 'out/repo.zip']);
    expect(code).toBe(0);
    const written = readFileSync(join(tmp, 'out', 'repo.zip'));
    expect(written.byteLength).toBe(5);
    expect(stripAnsi(stdout)).toContain('Wrote');
  });

  test('every subcommand rejects a missing positional with exit 2 and no request', async () => {
    for (const argv of [['cat'], ['search'], ['history'], ['show'], ['diff']]) {
      stdout = '';
      stderr = '';
      requests = [];
      const code = await runFiles(argv);
      expect(code).toBe(2);
      expect(requests).toHaveLength(0);
      expect(stripAnsi(stderr)).toContain('Pass');
    }
  });

  test('an unknown subcommand exits 2 with the help', async () => {
    const code = await runFiles(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown subcommand "frobnicate"');
    expect(stderr).toContain('Usage: kortix files');
  });
});
