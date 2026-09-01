import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createSubprojectAuthorSession,
  createSubprojectInstallSession,
  createSubprojectUninstallSession,
  deleteSubproject,
  getSubproject,
  listSubprojectRuns,
  listSubprojects,
  listProjectSubprojectRuns,
  listProjectSubprojects,
  setSubprojectActivation,
  submitSubproject,
  submitSubprojectArchive,
} from './subprojects';

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

test('listSubprojects hits /subprojects with no query string when given nothing', async () => {
  nextResponse = { status: 200, body: { subprojects: [], total: 0, limit: 50, offset: 0 } };
  const res = await listSubprojects();
  expect(last().url).toBe('http://test.local/subprojects');
  expect(res.total).toBe(0);
});

test('listSubprojects passes q, limit and offset through', async () => {
  nextResponse = { status: 200, body: { subprojects: [], total: 0, limit: 10, offset: 20 } };
  await listSubprojects({ q: 'seo', limit: 10, offset: 20 });
  expect(last().url).toContain('q=seo');
  expect(last().url).toContain('limit=10');
  expect(last().url).toContain('offset=20');
});

test('submitSubproject POSTs the repo address as JSON', async () => {
  nextResponse = { status: 201, body: { subproject: { subproject_id: 'c1' }, warnings: [] } };
  const res = await submitSubproject({ repo: 'acme/seo-subproject@v1', visibility: 'public' });
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/subprojects');
  expect(last().body).toEqual({ repo: 'acme/seo-subproject@v1', visibility: 'public' });
  expect(res.subproject.subproject_id).toBe('c1');
});

test('submitSubproject omits visibility when the caller does not choose one', async () => {
  // The server defaults to private; sending `undefined` would be noise.
  nextResponse = { status: 201, body: { subproject: { subproject_id: 'c1' }, warnings: [] } };
  await submitSubproject({ repo: 'acme/x' });
  expect(last().body).toEqual({ repo: 'acme/x' });
});

test('submitSubprojectArchive POSTs multipart with the archive as `file`', async () => {
  nextResponse = { status: 201, body: { subproject: { subproject_id: 'c2' }, warnings: [] } };
  const archive = new File([new Uint8Array([1, 2, 3])], 'seo-subproject.zip', {
    type: 'application/zip',
  });
  await submitSubprojectArchive({ file: archive, visibility: 'private' });
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/subprojects');
  const form = last().raw as FormData;
  expect(form instanceof FormData).toBe(true);
  expect((form.get('file') as File).name).toBe('seo-subproject.zip');
  expect(form.get('visibility')).toBe('private');
});

test('submitSubprojectArchive sets NO content-type — the boundary must come from FormData', async () => {
  // Setting `application/json`, or any explicit multipart value without the
  // generated boundary, makes the server unable to parse the body.
  nextResponse = { status: 201, body: { subproject: {}, warnings: [] } };
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
  await submitSubprojectArchive({ file: new File([new Uint8Array([1])], 'a.zip') });
  expect(seen['content-type']).toBeUndefined();
});

test('getSubproject reads one subproject by id', async () => {
  nextResponse = { status: 200, body: { subproject: { subproject_id: 'c1', slug: 'seo' } } };
  const subproject = await getSubproject('c1');
  expect(last().url).toBe('http://test.local/subprojects/c1');
  expect(subproject.slug).toBe('seo');
});

test('getSubproject url-encodes the id', async () => {
  nextResponse = { status: 200, body: { subproject: {} } };
  await getSubproject('a/b');
  expect(last().url).toBe('http://test.local/subprojects/a%2Fb');
});

test('deleteSubproject DELETEs by id', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteSubproject('c1');
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe('http://test.local/subprojects/c1');
});

// ── per-project ────────────────────────────────────────────────────────────

test('listProjectSubprojects reads what is installed in one project', async () => {
  nextResponse = { status: 200, body: { subprojects: [{ slug: 'seo' }], errors: [] } };
  const res = await listProjectSubprojects('p1');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects');
  expect(res.subprojects[0].slug).toBe('seo');
});

test('createSubprojectInstallSession POSTs the subproject id and returns the session', async () => {
  nextResponse = { status: 201, body: { session_id: 's1' } };
  const res = await createSubprojectInstallSession('p1', 'c1');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/install-session');
  expect(last().body).toEqual({ subproject_id: 'c1' });
  expect(res.session_id).toBe('s1');
});

test('createSubprojectUninstallSession targets the installed SLUG, not a subproject id', async () => {
  // Uninstall is keyed on what the project manifest records, which is the slug.
  nextResponse = { status: 201, body: { session_id: 's2' } };
  await createSubprojectUninstallSession('p1', 'seo-watch');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/seo-watch/uninstall-session');
});

test('createSubprojectAuthorSession POSTs the description and returns the session', async () => {
  nextResponse = { status: 201, body: { session_id: 's3' } };
  const res = await createSubprojectAuthorSession('p1', 'watch my competitors weekly');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/author-session');
  expect(last().body).toEqual({ description: 'watch my competitors weekly' });
  expect(res.session_id).toBe('s3');
});

test('setSubprojectActivation PATCHes the subproject slug with the boolean', async () => {
  // The project-wide pause is a different route entirely
  // (`/triggers/activation`). This one is scoped to one subproject's own triggers.
  nextResponse = {
    status: 200,
    body: { ok: true, subproject_slug: 'seo-watch', title: 'SEO watch', enabled: true, triggers: ['weekly'] },
  };
  const res = await setSubprojectActivation('p1', 'seo-watch', true);
  expect(last().method).toBe('PATCH');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/seo-watch/activation');
  expect(last().body).toEqual({ enabled: true });
  expect(res.triggers).toEqual(['weekly']);
});

test('setSubprojectActivation can disable, and reports an empty trigger list as a no-op', async () => {
  // An empty `triggers` array means the subproject was ALREADY in this state — a
  // different answer from "it worked", and callers need to be able to tell.
  nextResponse = {
    status: 200,
    body: { ok: true, subproject_slug: 'seo-watch', title: 'SEO watch', enabled: false, triggers: [] },
  };
  const res = await setSubprojectActivation('p1', 'seo-watch', false);
  expect(last().body).toEqual({ enabled: false });
  expect(res.enabled).toBe(false);
  expect(res.triggers).toEqual([]);
});

// ── runs ───────────────────────────────────────────────────────────────────

test('listProjectSubprojectRuns reads runs across every subproject', async () => {
  nextResponse = { status: 200, body: { runs: [], total: 0, limit: 50, offset: 0 } };
  await listProjectSubprojectRuns('p1');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/runs');
});

test('listSubprojectRuns reads one subproject and returns its stats', async () => {
  nextResponse = {
    status: 200,
    body: {
      subproject_slug: 'seo-watch',
      runs: [{ execution_id: 'e1', status: 'done' }],
      total: 1,
      limit: 50,
      offset: 0,
      stats: { total: 1, done: 1, failed: 0, successRate: 100, avgDurationSeconds: 60 },
    },
  };
  const res = await listSubprojectRuns('p1', 'seo-watch');
  expect(last().url).toBe('http://test.local/projects/p1/subprojects/seo-watch/runs');
  expect(res.stats.successRate).toBe(100);
  expect(res.runs[0].status).toBe('done');
});

test('listSubprojectRuns paginates', async () => {
  nextResponse = {
    status: 200,
    body: { subproject_slug: 'x', runs: [], total: 0, limit: 5, offset: 10, stats: {} },
  };
  await listSubprojectRuns('p1', 'x', { limit: 5, offset: 10 });
  expect(last().url).toContain('limit=5');
  expect(last().url).toContain('offset=10');
});

test('every subproject path url-encodes its project id and slug', async () => {
  nextResponse = { status: 200, body: { runs: [], total: 0 } };
  await listSubprojectRuns('p/1', 'a b');
  expect(last().url).toContain('/projects/p%2F1/subprojects/a%20b/runs');
});
