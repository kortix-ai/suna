/**
 * GET /v1/projects/:projectId/files?depth=1 — paged folder listings (KRTX-1723).
 *
 * A folder over 500 entries is read in pages: `limit` or `cursor` asks for a
 * page, `next_cursor` names the next one, and every page reads the commit the
 * first page read. A request with neither keeps the one-response contract (up
 * to 5,000 entries, `next_cursor: null`). The test drives the REAL handler
 * through the shared `projectsApp` against a REAL git repository; only the
 * mirror location, the access layer and the visibility denier are stubbed
 * (`mock.module` is process-global in bun:test, so this runs in its own file).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const PROJECT_ID = '00000000-0000-4000-a000-0000000172a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000172a1';
const USER_ID = '00000000-0000-4000-a000-0000000172a2';

let repoPath = '';
/** Set to make every mirror read fail, as an unreachable remote does. */
let mirrorDown = false;
/** Paths the visibility denier hides. */
let hidden: (path: string) => boolean = () => false;

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: new Proxy({}, {
    get: () => () => new Proxy({}, { get: () => () => ({ returning: async () => [] }) }),
  }),
}));

const realMirror = await import('../git/mirror');
mock.module('../git/mirror', () => ({
  ...realMirror,
  refreshMirror: async () => {
    if (mirrorDown) throw new Error('fatal: unable to access the remote');
    return repoPath;
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, defaultBranch: 'main', repoUrl: 'https://example.test/r.git' },
    projectRole: 'owner',
    effectiveRole: 'owner',
  }),
  assertProjectCapability: async () => {},
}));

const realGitLib = await import('../lib/git');
mock.module('../lib/git', () => ({
  ...realGitLib,
  withProjectGitAuth: async (row: Record<string, unknown>) => ({ ...row, gitAuthToken: null, gitAuthHeaders: {} }),
}));

const realResources = await import('../lib/project-resources');
mock.module('../lib/project-resources', () => ({
  ...realResources,
  resourceDenierForRequest: async () => ({ isDenied: (path: string) => hidden(path), containsDenied: () => false }),
}));

const { projectsApp } = await import('../lib/app');
(await import('./project-files')).registerProjectFilesRoutes();

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.invalid',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.invalid',
};

interface Listing {
  entries: { path: string; type: string }[];
  truncated: boolean;
  next_cursor: string | null;
}

async function list(query: Record<string, string>) {
  const res = await projectsApp.request(`/${PROJECT_ID}/files?${new URLSearchParams({ depth: '1', ...query })}`);
  return { status: res.status, body: (await res.json()) as Listing & { error?: unknown } };
}

beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'kortix-directory-pages-'));
  await exec('git', ['init', '-q', '-b', 'main', repoPath], { env: GIT_ENV });
  await mkdir(join(repoPath, 'a'));
  await mkdir(join(repoPath, 'z'));
  for (let i = 0; i < 1200; i++) await writeFile(join(repoPath, 'a', `f${String(i).padStart(4, '0')}.txt`), `${i}\n`);
  await writeFile(join(repoPath, 'z', 'last.txt'), 'last\n');
  await exec('git', ['-C', repoPath, 'add', '-A'], { env: GIT_ENV });
  await exec('git', ['-C', repoPath, 'commit', '-qm', 'seed'], { env: GIT_ENV });
});

afterAll(async () => {
  if (repoPath) await rm(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  mirrorDown = false;
  hidden = () => false;
});

async function walk(query: Record<string, string>) {
  const pages: Listing[] = [];
  let cursor: string | null = null;
  do {
    const { status, body } = await list(cursor ? { ...query, cursor } : query);
    expect(status).toBe(200);
    pages.push(body);
    cursor = body.next_cursor;
  } while (cursor);
  return pages;
}

describe('GET /:projectId/files?depth=1 — pages', () => {
  test('without limit or cursor: the whole folder in one response, next_cursor null', async () => {
    const { status, body } = await list({ path: 'a' });
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1200);
    expect(body.truncated).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  test('limit=500 walks 1,200 entries as 500 + 500 + 200, every name once, in order', async () => {
    const pages = await walk({ path: 'a', limit: '500' });
    expect(pages.map((p) => p.entries.length)).toEqual([500, 500, 200]);
    expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);
    expect(pages.map((p) => typeof p.next_cursor)).toEqual(['string', 'string', 'object']);
    const names = pages.flatMap((p) => p.entries.map((e) => e.path));
    expect(names).toEqual(Array.from({ length: 1200 }, (_, i) => `a/f${String(i).padStart(4, '0')}.txt`));
  });

  test('a cursor alone pages at the default size of 500', async () => {
    const first = await list({ path: 'a', limit: '100' });
    const { body } = await list({ path: 'a', cursor: first.body.next_cursor! });
    expect(body.entries).toHaveLength(500);
    expect(body.entries[0]!.path).toBe('a/f0100.txt');
  });

  test('a hidden entry never fills a page or ends one', async () => {
    hidden = (path) => /[13579]\.txt$/.test(path);
    const pages = await walk({ path: 'a', limit: '500' });
    expect(pages.map((p) => p.entries.length)).toEqual([500, 100]);
    expect(pages.flatMap((p) => p.entries).some((e) => hidden(e.path))).toBe(false);
  });

  test('limit outside 1..2,000 or not an integer is a 400', async () => {
    for (const limit of ['0', '2001', '1.5', 'abc', '']) {
      expect((await list({ path: 'a', limit })).status).toBe(400);
    }
    expect((await list({ path: 'a', limit: '2000' })).status).toBe(200);
  });

  test('a malformed cursor, an empty one, or one of another folder, is a 400', async () => {
    expect((await list({ path: 'a', cursor: 'garbage' })).status).toBe(400);
    expect((await list({ path: 'a', cursor: '' })).status).toBe(400);
    const { body } = await list({ path: 'a', limit: '500' });
    const foreign = await list({ path: 'z', cursor: body.next_cursor! });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('Invalid cursor');
  });

  test('a failed read with a cursor is a 503, never an empty last page', async () => {
    const { body } = await list({ path: 'a', limit: '500' });
    mirrorDown = true;
    const later = await list({ path: 'a', cursor: body.next_cursor! });
    expect(later.status).toBe(503);
    // The first page keeps the old answer: an empty listing flagged by a header.
    const res = await projectsApp.request(`/${PROJECT_ID}/files?depth=1&path=a&limit=500`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Kortix-Repo-Status')).toBe('unavailable');
    expect(await res.json()).toEqual({ entries: [], truncated: false, next_cursor: null });
  });
});

// The query schema documents `limit` and `cursor`; only `depth=1` checks them.
// Without `depth` the route answers every query it answered before paging.
describe('GET /:projectId/files — the query it took before paging', () => {
  async function get(search: string) {
    const res = await projectsApp.request(`/${PROJECT_ID}/files?${search}`);
    return { status: res.status, body: (await res.json()) as unknown };
  }

  test('the recursive list ignores limit and cursor, whatever their value', async () => {
    for (const search of ['limit=5000', 'limit=abc', 'limit=0', 'cursor=garbage', 'path=a&limit=1.5']) {
      const { status, body } = await get(search);
      expect({ search, status }).toEqual({ search, status: 200 });
      expect(Array.isArray(body)).toBe(true);
    }
    expect(((await get('path=a&limit=5000')).body as unknown[]).length).toBe(1000);
  });

  test('a repeated key reads its first value', async () => {
    const { status, body } = await get('depth=1&path=a&path=z');
    expect(status).toBe(200);
    expect((body as Listing).entries).toHaveLength(1200);
  });

  test('the OpenAPI document lists ref, path, depth, limit and cursor', () => {
    const doc = projectsApp.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 't', version: '1' } });
    type Param = { name: string; in: string; required?: boolean; schema?: { type?: string; description?: string } };
    const params = (doc.paths['/{projectId}/files']?.get?.parameters ?? []) as Param[];
    const query = params.filter((p) => p.in === 'query');
    expect(query.map((p) => p.name).sort()).toEqual(['cursor', 'depth', 'limit', 'path', 'ref']);
    expect(query.every((p) => !p.required && p.schema?.type === 'string' && !!p.schema.description)).toBe(true);
    expect(query.find((p) => p.name === 'limit')!.schema!.description).toContain('from 1 to 2000');
  });
});

describe('single-file reads reject repository-root paths (KRTX-3551)', () => {
  for (const route of ['raw', 'content', 'history']) {
    for (const path of ['.', './', './//']) {
      test(`${route}: ${path} returns 404 instead of throwing`, async () => {
        const response = await projectsApp.request(`/${PROJECT_ID}/files/${route}?${new URLSearchParams({ path })}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'File not found' });
      });
    }
    if (route !== 'history') test(`${route}: a repository-relative file still reads`, async () => {
      const response = await projectsApp.request(`/${PROJECT_ID}/files/${route}?${new URLSearchParams({ path: './z/last.txt' })}`);
      expect(response.status).toBe(200);
      if (route === 'raw') expect(await response.text()).toBe('last\n');
      else expect(await response.json()).toMatchObject({ path: './z/last.txt', ref: 'main', content: 'last\n' });
    });
  }
});

// NUL is not representable in a Git path or process argument (KRTX-3404).
describe('file read paths', () => {
  for (const endpoint of ['content', 'raw', 'history']) {
    for (const path of ['\0', '\0a', 'a\0b', 'a\0']) {
      test(`${endpoint} rejects ${JSON.stringify(path)} without spawning git`, async () => {
        const response = await projectsApp.request(`/${PROJECT_ID}/files/${endpoint}?${new URLSearchParams({ path })}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'File not found' });
      });
    }
  }
});
