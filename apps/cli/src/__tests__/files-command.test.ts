// Black-box characterization coverage for `kortix files` (KRTX-1334): every
// subcommand's outgoing request path + rendered output, pinned BEFORE the
// runFiles handler split so the refactor cannot change a byte.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type FakeApi,
  runCommand,
  startFakeApi,
  writeConfig,
  writeRunner,
} from './support/account-cli-harness.ts';

const PROJECT = 'proj_1';
const BASE = `/v1/projects/${PROJECT}`;
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** Four bytes of a real zip local-file header — proves the body was written
 *  through byte-for-byte. Same trick as projects-parity.test.ts. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);

const COMMIT = {
  hash: SHA,
  short_hash: 'a1b2c3d',
  parents: [],
  author_name: 'Ada',
  author_email: 'ada@corp.test',
  authored_at: '2026-03-01T00:00:00.000Z',
  committer_name: 'Ada',
  committer_email: 'ada@corp.test',
  committed_at: '2026-03-01T00:00:00.000Z',
  subject: 'Add README',
  body: '',
};

const routes: Parameters<typeof startFakeApi>[0] = (req, url) => {
  const p = url.pathname;
  if (p === `${BASE}/files` && req.method === 'GET' && url.searchParams.get('path') === 'big') {
    // The server's recursive list stops at 1,000 files and says so (KRTX-1723).
    return Response.json(
      Array.from({ length: 1000 }, (_, i) => ({ path: `big/f${i}.txt`, type: 'file', size: 1 })),
      { headers: { 'x-kortix-truncated': '1' } },
    );
  }
  if (p === `${BASE}/files` && req.method === 'GET') {
    return Response.json([
      { path: 'src/main.ts', type: 'file', size: 2048 },
      { path: 'README.md', type: 'file', size: 12 },
    ]);
  }
  if (p === `${BASE}/files/content` && req.method === 'GET') {
    return Response.json({ path: 'README.md', ref: 'main', content: 'hello\n' });
  }
  if (p === `${BASE}/files/search` && req.method === 'GET') {
    return Response.json({
      results: [{ path: 'src/main.ts', line_number: 3, line_text: '  const run = 1' }],
    });
  }
  if (p === `${BASE}/files/history` && req.method === 'GET') {
    return Response.json({ commits: [COMMIT], hasMore: true });
  }
  if (p === `${BASE}/branches` && req.method === 'GET') {
    return Response.json({
      default_branch: 'main',
      branches: [
        {
          name: 'main',
          is_default: true,
          tip: SHA,
          tip_short: 'a1b2c3d',
          subject: 'Add README',
          committer_name: 'Ada',
          committed_at: '2026-03-01T00:00:00.000Z',
          ahead: 0,
          behind: 0,
        },
      ],
    });
  }
  if (p === `${BASE}/commits` && req.method === 'GET') {
    return Response.json({ commits: [COMMIT], hasMore: false });
  }
  if (p === `${BASE}/commits/${SHA}` && req.method === 'GET') {
    return Response.json({
      ...COMMIT,
      files: [
        { path: 'README.md', old_path: null, status: 'added', additions: 12, deletions: 0 },
        { path: 'old.md', old_path: 'renamed.md', status: 'modified', additions: 1, deletions: 2 },
      ],
    });
  }
  if (p === `${BASE}/commits/${SHA}/diff` && req.method === 'GET') {
    return Response.json({ patch: 'diff --git a/README.md b/README.md\n' });
  }
  if (p === `${BASE}/files/archive` && req.method === 'GET') {
    return new Response(ZIP_BYTES, { status: 200, headers: { 'Content-Type': 'application/zip' } });
  }
  return undefined;
};

let tmp: string;
let runner: string;
let api: FakeApi | null = null;
let config: string;

function boot(): void {
  api = startFakeApi(routes);
  config = writeConfig(tmp, api.url);
}

/** Every invocation pins the project explicitly — no link.json in play. The
 *  subcommand leads; flags come after it, as the real CLI passes them. */
async function run(args: string[]) {
  return runCommand(runner, [args[0], '--project', PROJECT, ...args.slice(1)], {
    cwd: tmp,
    configFile: config,
  });
}

describe('kortix files', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-files-'));
    runner = writeRunner(tmp, 'files.ts', 'runFiles');
  });

  afterEach(() => {
    api?.stop();
    api = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help documents every subcommand', async () => {
    boot();
    const h = await run(['--help']);
    expect(h.code).toBe(0);
    for (const fragment of [
      'Usage: kortix files',
      'ls [<path>]',
      'cat <path>',
      'search <query>',
      'history <path>',
      'branches',
      'commits [--path <p>]',
      'show <sha>',
      'diff <sha>',
      'download -o <out.zip>',
      'project.file.read',
    ]) {
      expect(h.stdout).toContain(fragment);
    }
  });

  test('ls lists paths with sizes; --json emits the raw entries', async () => {
    boot();
    const r = await run(['ls', 'src']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/files`,
      query: '?path=src',
    });
    expect(r.stdout).toContain('src/main.ts');
    expect(r.stdout).toContain('2.0K');
    expect(r.stdout).toContain('2 files');

    const j = await run(['ls', '--json']);
    expect(JSON.parse(j.stdout)).toHaveLength(2);
    expect(r.stdout).not.toContain('stops at');
  });

  test('ls says when the list stops at 1,000 files instead of presenting it as complete', async () => {
    boot();
    const r = await run(['ls', 'big']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1000 files');
    expect(r.stdout).toContain('The list stops at 1,000 files');
    expect(r.stdout).toContain('kortix files search');
  });

  test('cat prints file contents', async () => {
    boot();
    const r = await run(['cat', 'README.md']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/files/content`,
      query: '?path=README.md',
    });
    expect(r.stdout).toBe('hello\n');

    const j = await run(['cat', 'README.md', '--json']);
    expect(JSON.parse(j.stdout)).toMatchObject({ content: 'hello\n', ref: 'main' });
  });

  test('search sends q (+content) and renders path:line hits', async () => {
    boot();
    const r = await run(['search', 'run', '--content']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/files/search`,
      query: '?q=run&content=1',
    });
    expect(r.stdout).toContain('src/main.ts:3');
    expect(r.stdout).toContain('const run = 1');
    expect(r.stdout).toContain('1 match');
  });

  test('history pins path + limit and notes more commits', async () => {
    boot();
    const r = await run(['history', 'README.md', '--limit', '2']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/files/history`,
      query: '?path=README.md&limit=2',
    });
    expect(r.stdout).toContain('a1b2c3d');
    expect(r.stdout).toContain('Add README');
    expect(r.stdout).toContain('more available');
  });

  test('branches requests the full remote and marks the default', async () => {
    boot();
    const r = await run(['branches']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/branches`,
      query: '?include_session_branches=true&limit=2000',
    });
    expect(r.stdout).toContain('main');
    expect(r.stdout).toContain('default: main · 1 branches');
  });

  test('commits scopes by --path and --limit', async () => {
    boot();
    const r = await run(['commits', '--path', 'src', '--limit', '5']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/commits`,
      query: '?path=src&limit=5',
    });
    expect(r.stdout).toContain('a1b2c3d');
    expect(r.stdout).toContain('1 commit');
  });

  test('show renders one commit + its changed files', async () => {
    boot();
    const r = await run(['show', SHA]);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({ method: 'GET', path: `${BASE}/commits/${SHA}` });
    expect(r.stdout).toContain('Add README');
    expect(r.stdout).toContain('Ada <ada@corp.test>');
    expect(r.stdout).toContain('A README.md');
    expect(r.stdout).toContain('renamed.md → old.md');
    expect(r.stdout).toContain('2 files changed');

    const j = await run(['show', SHA, '--json']);
    expect(JSON.parse(j.stdout)).toMatchObject({ subject: 'Add README' });
  });

  test('diff prints the patch and passes --path through', async () => {
    boot();
    const r = await run(['diff', SHA, '--path', 'src/app.ts']);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/commits/${SHA}/diff`,
      query: '?path=src%2Fapp.ts',
    });
    expect(r.stdout).toBe('diff --git a/README.md b/README.md\n');
  });

  test('download streams the zip byte-for-byte to -o; --json summarizes', async () => {
    boot();
    const out = join(tmp, 'nested', 'workspace.zip');
    const r = await run(['download', '--ref', 'feature/x', '--path', '.kortix', '-o', out]);
    expect(r.code).toBe(0);
    expect(api?.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/files/archive`,
      query: '?ref=feature%2Fx&path=.kortix',
    });
    expect(new Uint8Array(readFileSync(out))).toEqual(ZIP_BYTES);
    expect(r.stdout).toContain('Wrote');

    const out2 = join(tmp, 'w.zip');
    const j = await run(['download', '-o', out2, '--json']);
    expect(j.code).toBe(0);
    const parsed = JSON.parse(j.stdout) as { bytes: number; ref: string | null };
    expect(parsed.bytes).toBe(ZIP_BYTES.byteLength);
    expect(parsed.ref).toBeNull();
  });

  test('missing required arguments and unknown subcommands exit 2 without HTTP', async () => {
    boot();
    for (const args of [
      ['cat'],
      ['search'],
      ['history'],
      ['show'],
      ['diff'],
      ['download'],
      ['nope'],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(2);
    }
    expect(api?.requests).toHaveLength(0);
  });
});
