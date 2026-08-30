import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createCraftInstallSession,
  createCraftUninstallSession,
  deleteCraft,
  getCraft,
  listCraftRuns,
  listCrafts,
  listProjectCraftRuns,
  listProjectCrafts,
  submitCraft,
  submitCraftArchive,
} from './crafts';

let calls: { url: string; method: string; body: unknown; raw: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: unknown } = {}) => {
    let parsed: unknown;
    if (typeof opts.body === 'string') {
      try {
        parsed = JSON.parse(opts.body);
      } catch {
        parsed = opts.body;
      }
    }
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: parsed,
      raw: opts.body,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

// ── the index ──────────────────────────────────────────────────────────────

test('listCrafts hits /crafts with no query string when given nothing', async () => {
  nextResponse = { status: 200, body: { crafts: [], total: 0, limit: 50, offset: 0 } };
  const res = await listCrafts();
  expect(last().url).toBe('http://test.local/crafts');
  expect(res.total).toBe(0);
});

test('listCrafts passes q, limit and offset through', async () => {
  nextResponse = { status: 200, body: { crafts: [], total: 0, limit: 10, offset: 20 } };
  await listCrafts({ q: 'seo', limit: 10, offset: 20 });
  expect(last().url).toContain('q=seo');
  expect(last().url).toContain('limit=10');
  expect(last().url).toContain('offset=20');
});

test('submitCraft POSTs the repo address as JSON', async () => {
  nextResponse = { status: 201, body: { craft: { craft_id: 'c1' }, warnings: [] } };
  const res = await submitCraft({ repo: 'acme/seo-craft@v1', visibility: 'public' });
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/crafts');
  expect(last().body).toEqual({ repo: 'acme/seo-craft@v1', visibility: 'public' });
  expect(res.craft.craft_id).toBe('c1');
});

test('submitCraft omits visibility when the caller does not choose one', async () => {
  // The server defaults to private; sending `undefined` would be noise.
  nextResponse = { status: 201, body: { craft: { craft_id: 'c1' }, warnings: [] } };
  await submitCraft({ repo: 'acme/x' });
  expect(last().body).toEqual({ repo: 'acme/x' });
});

test('submitCraftArchive POSTs multipart with the archive as `file`', async () => {
  nextResponse = { status: 201, body: { craft: { craft_id: 'c2' }, warnings: [] } };
  const archive = new File([new Uint8Array([1, 2, 3])], 'seo-craft.zip', {
    type: 'application/zip',
  });
  await submitCraftArchive({ file: archive, visibility: 'private' });
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/crafts');
  const form = last().raw as FormData;
  expect(form instanceof FormData).toBe(true);
  expect((form.get('file') as File).name).toBe('seo-craft.zip');
  expect(form.get('visibility')).toBe('private');
});

test('submitCraftArchive sets NO content-type — the boundary must come from FormData', async () => {
  // Setting `application/json`, or any explicit multipart value without the
  // generated boundary, makes the server unable to parse the body.
  nextResponse = { status: 201, body: { craft: {}, warnings: [] } };
  const seen: Record<string, string> = {};
  globalThis.fetch = mock(
    async (
      _url: unknown,
      opts: { headers?: HeadersInit; method?: string; body?: unknown } = {},
    ) => {
      for (const [k, v] of new Headers(opts.headers ?? {}).entries()) seen[k.toLowerCase()] = v;
      calls.push({
        url: String(_url),
        method: opts.method ?? 'GET',
        body: undefined,
        raw: opts.body,
      });
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    },
  ) as unknown as typeof fetch;
  await submitCraftArchive({ file: new File([new Uint8Array([1])], 'a.zip') });
  expect(seen['content-type']).toBeUndefined();
});

test('getCraft reads one craft by id', async () => {
  nextResponse = { status: 200, body: { craft: { craft_id: 'c1', slug: 'seo' } } };
  const craft = await getCraft('c1');
  expect(last().url).toBe('http://test.local/crafts/c1');
  expect(craft.slug).toBe('seo');
});

test('getCraft url-encodes the id', async () => {
  nextResponse = { status: 200, body: { craft: {} } };
  await getCraft('a/b');
  expect(last().url).toBe('http://test.local/crafts/a%2Fb');
});

test('deleteCraft DELETEs by id', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteCraft('c1');
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe('http://test.local/crafts/c1');
});

// ── per-project ────────────────────────────────────────────────────────────

test('listProjectCrafts reads what is installed in one project', async () => {
  nextResponse = { status: 200, body: { crafts: [{ slug: 'seo' }], errors: [] } };
  const res = await listProjectCrafts('p1');
  expect(last().url).toBe('http://test.local/projects/p1/crafts');
  expect(res.crafts[0].slug).toBe('seo');
});

test('createCraftInstallSession POSTs the craft id and returns the session', async () => {
  nextResponse = { status: 201, body: { session_id: 's1' } };
  const res = await createCraftInstallSession('p1', 'c1');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/crafts/install-session');
  expect(last().body).toEqual({ craft_id: 'c1' });
  expect(res.session_id).toBe('s1');
});

test('createCraftUninstallSession targets the installed SLUG, not a craft id', async () => {
  // Uninstall is keyed on what the project manifest records, which is the slug.
  nextResponse = { status: 201, body: { session_id: 's2' } };
  await createCraftUninstallSession('p1', 'seo-watch');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/crafts/seo-watch/uninstall-session');
});

// ── runs ───────────────────────────────────────────────────────────────────

test('listProjectCraftRuns reads runs across every craft', async () => {
  nextResponse = { status: 200, body: { runs: [], total: 0, limit: 50, offset: 0 } };
  await listProjectCraftRuns('p1');
  expect(last().url).toBe('http://test.local/projects/p1/crafts/runs');
});

test('listCraftRuns reads one craft and returns its stats', async () => {
  nextResponse = {
    status: 200,
    body: {
      craft_slug: 'seo-watch',
      runs: [{ execution_id: 'e1', status: 'done' }],
      total: 1,
      limit: 50,
      offset: 0,
      stats: { total: 1, done: 1, failed: 0, successRate: 100, avgDurationSeconds: 60 },
    },
  };
  const res = await listCraftRuns('p1', 'seo-watch');
  expect(last().url).toBe('http://test.local/projects/p1/crafts/seo-watch/runs');
  expect(res.stats.successRate).toBe(100);
  expect(res.runs[0].status).toBe('done');
});

test('listCraftRuns paginates', async () => {
  nextResponse = {
    status: 200,
    body: { craft_slug: 'x', runs: [], total: 0, limit: 5, offset: 10, stats: {} },
  };
  await listCraftRuns('p1', 'x', { limit: 5, offset: 10 });
  expect(last().url).toContain('limit=5');
  expect(last().url).toContain('offset=10');
});

test('every craft path url-encodes its project id and slug', async () => {
  nextResponse = { status: 200, body: { runs: [], total: 0 } };
  await listCraftRuns('p/1', 'a b');
  expect(last().url).toContain('/projects/p%2F1/crafts/a%20b/runs');
});
