import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  MarketplaceError,
  createMarketplaceInstallSession,
  getMarketplaceTemplate,
  listMarketplaceTemplates,
} from './marketplace';

let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(
    async (url: unknown, opts: { method?: string; headers?: HeadersInit; body?: unknown } = {}) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of new Headers(opts.headers ?? {}).entries()) headers[k.toLowerCase()] = v;
      let body: unknown;
      if (typeof opts.body === 'string') {
        try {
          body = JSON.parse(opts.body);
        } catch {
          body = opts.body;
        }
      }
      calls.push({ url: String(url), method: opts.method ?? 'GET', headers, body });
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
  slug: 'seo-watch',
  title: 'SEO Watch',
  description: 'Crawls your site every Monday.',
  repo: 'acme/seo-watch',
  repo_owner: 'acme',
  repo_name: 'seo-watch',
  git_ref: null,
  resolved_sha: '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7',
  agents: [{ name: 'seo-writer', description: null }],
  triggers: [],
  connectors: [],
  skills: ['site-crawl'],
  env_required: [],
};

// ── the catalog: public, no token ──────────────────────────────────────────

test('listMarketplaceTemplates hits /public/marketplace/templates with no Authorization header', async () => {
  nextResponse = { status: 200, body: { templates: [CARD] } };
  const result = await listMarketplaceTemplates();
  expect(last().url).toBe('http://test.local/public/marketplace/templates');
  expect(last().method).toBe('GET');
  // A logged-in visitor's token must not leak into an ISR-cached render — the
  // catalog is the same bytes for everyone.
  expect(last().headers.authorization).toBeUndefined();
  expect(result.templates[0].slug).toBe('seo-watch');
});

test('listMarketplaceTemplates passes a trimmed q, and omits an empty one', async () => {
  nextResponse = { status: 200, body: { templates: [] } };
  await listMarketplaceTemplates({ q: '  lockfile  ' });
  expect(last().url).toBe('http://test.local/public/marketplace/templates?q=lockfile');
  await listMarketplaceTemplates({ q: '   ' });
  expect(last().url).toBe('http://test.local/public/marketplace/templates');
});

test('getMarketplaceTemplate reads one card by SLUG and unwraps it', async () => {
  nextResponse = { status: 200, body: { template: CARD } };
  const result = await getMarketplaceTemplate('seo-watch');
  expect(last().url).toBe('http://test.local/public/marketplace/templates/seo-watch');
  expect(last().headers.authorization).toBeUndefined();
  expect(result.title).toBe('SEO Watch');
  expect(result.skills).toEqual(['site-crawl']);
});

test('getMarketplaceTemplate encodes the slug', async () => {
  nextResponse = { status: 200, body: { template: CARD } };
  await getMarketplaceTemplate('a/b c');
  expect(last().url).toBe('http://test.local/public/marketplace/templates/a%2Fb%20c');
});

test('getMarketplaceTemplate throws a MarketplaceError carrying 404', async () => {
  nextResponse = { status: 404, body: { error: 'Template not found' } };
  try {
    await getMarketplaceTemplate('nope');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).status).toBe(404);
    expect((err as Error).message).toBe('Template not found');
  }
});

test('listMarketplaceTemplates surfaces 429 with the status preserved', async () => {
  nextResponse = { status: 429, body: { error: 'Too many requests' } };
  try {
    await listMarketplaceTemplates();
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).status).toBe(429);
  }
});

// ── the install: per-project, authenticated ────────────────────────────────

test('createMarketplaceInstallSession POSTs the slug with the token and returns the session', async () => {
  nextResponse = { status: 201, body: { session_id: 's1' } };
  const res = await createMarketplaceInstallSession('p1', 'seo-watch');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/marketplace/install-session');
  expect(last().headers.authorization).toBe('Bearer tok');
  expect(last().body).toEqual({ slug: 'seo-watch' });
  expect(res.session_id).toBe('s1');
});

test('createMarketplaceInstallSession url-encodes the project id', async () => {
  nextResponse = { status: 201, body: { session_id: 's2' } };
  await createMarketplaceInstallSession('p/1', 'seo-watch');
  expect(last().url).toBe('http://test.local/projects/p%2F1/marketplace/install-session');
});
