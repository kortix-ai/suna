import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  PublicSubprojectError,
  getPublicSubproject,
  listPublicSubprojects,
} from './public-subprojects';

let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(
    async (url: unknown, opts: { method?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ url: String(url), method: opts.method ?? 'GET', headers: opts.headers ?? {} });
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

const CARD = {
  subproject_id: 'sp1',
  slug: 'seo-watch',
  source_kind: 'upload',
  repo: 'seo-watch',
  repo_owner: null,
  repo_name: null,
  upload_name: null,
  file_count: 3,
  git_ref: null,
  resolved_sha: null,
  title: 'SEO Watch',
  description: 'Crawls your site every Monday.',
  stars: null,
  install_count: 0,
  visibility: 'public',
  status: 'active',
  agents: [{ name: 'seo-writer', description: null }],
  triggers: [],
  connectors: [],
  skills: ['site-crawl'],
  env_required: [],
  account_id: null,
  submitted_by: null,
  last_crawled_at: null,
  last_error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

test('listPublicSubprojects hits /public/subprojects with no Authorization header', async () => {
  nextResponse = { status: 200, body: { subprojects: [CARD], total: 1, limit: 50, offset: 0 } };
  const result = await listPublicSubprojects();
  expect(last().url).toBe('http://test.local/public/subprojects');
  expect(last().method).toBe('GET');
  expect(last().headers.Authorization).toBeUndefined();
  expect(result.total).toBe(1);
  expect(result.subprojects[0].slug).toBe('seo-watch');
});

test('listPublicSubprojects passes q, limit and offset as query params', async () => {
  nextResponse = { status: 200, body: { subprojects: [], total: 0, limit: 12, offset: 24 } };
  await listPublicSubprojects({ q: '  lockfile  ', limit: 12, offset: 24 });
  expect(last().url).toBe('http://test.local/public/subprojects?q=lockfile&limit=12&offset=24');
});

test('listPublicSubprojects omits an empty q rather than sending q=', async () => {
  nextResponse = { status: 200, body: { subprojects: [], total: 0, limit: 50, offset: 0 } };
  await listPublicSubprojects({ q: '   ' });
  expect(last().url).toBe('http://test.local/public/subprojects');
});

test('getPublicSubproject reads one card by SLUG and unwraps it', async () => {
  nextResponse = { status: 200, body: { subproject: CARD } };
  const result = await getPublicSubproject('seo-watch');
  expect(last().url).toBe('http://test.local/public/subprojects/seo-watch');
  expect(last().headers.Authorization).toBeUndefined();
  expect(result.title).toBe('SEO Watch');
  expect(result.skills).toEqual(['site-crawl']);
});

test('getPublicSubproject encodes the slug', async () => {
  nextResponse = { status: 200, body: { subproject: CARD } };
  await getPublicSubproject('a/b c');
  expect(last().url).toBe('http://test.local/public/subprojects/a%2Fb%20c');
});

test('getPublicSubproject throws a PublicSubprojectError carrying 404', async () => {
  nextResponse = { status: 404, body: { error: 'Subproject not found' } };
  try {
    await getPublicSubproject('nope');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(PublicSubprojectError);
    expect((err as PublicSubprojectError).status).toBe(404);
    expect((err as Error).message).toBe('Subproject not found');
  }
});

test('listPublicSubprojects surfaces 429 with the status preserved', async () => {
  nextResponse = { status: 429, body: { error: 'Too many requests' } };
  try {
    await listPublicSubprojects();
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(PublicSubprojectError);
    expect((err as PublicSubprojectError).status).toBe(429);
  }
});
