import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  TemplateError,
  createTemplateInstallSession,
  getTemplateBySlug,
  listTemplateCatalog,
  listTemplateFiles,
  readTemplateFile,
} from './template-catalog';

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

test('listTemplateCatalog hits /public/templates with no Authorization header', async () => {
  nextResponse = { status: 200, body: { templates: [CARD] } };
  const result = await listTemplateCatalog();
  expect(last().url).toBe('http://test.local/public/templates');
  expect(last().method).toBe('GET');
  // A logged-in visitor's token must not leak into an ISR-cached render — the
  // catalog is the same bytes for everyone.
  expect(last().headers.authorization).toBeUndefined();
  expect(result.templates[0].slug).toBe('seo-watch');
});

test('listTemplateCatalog passes a trimmed q, and omits an empty one', async () => {
  nextResponse = { status: 200, body: { templates: [] } };
  await listTemplateCatalog({ q: '  lockfile  ' });
  expect(last().url).toBe('http://test.local/public/templates?q=lockfile');
  await listTemplateCatalog({ q: '   ' });
  expect(last().url).toBe('http://test.local/public/templates');
});

test('getTemplateBySlug reads one card by SLUG and unwraps it', async () => {
  nextResponse = { status: 200, body: { template: CARD } };
  const result = await getTemplateBySlug('seo-watch');
  expect(last().url).toBe('http://test.local/public/templates/seo-watch');
  expect(last().headers.authorization).toBeUndefined();
  expect(result.title).toBe('SEO Watch');
  expect(result.skills).toEqual(['site-crawl']);
});

test('getTemplateBySlug encodes the slug', async () => {
  nextResponse = { status: 200, body: { template: CARD } };
  await getTemplateBySlug('a/b c');
  expect(last().url).toBe('http://test.local/public/templates/a%2Fb%20c');
});

test('getTemplateBySlug throws a TemplateError carrying 404', async () => {
  nextResponse = { status: 404, body: { error: 'Template not found' } };
  try {
    await getTemplateBySlug('nope');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as TemplateError).status).toBe(404);
    expect((err as Error).message).toBe('Template not found');
  }
});

test('listTemplateCatalog surfaces 429 with the status preserved', async () => {
  nextResponse = { status: 429, body: { error: 'Too many requests' } };
  try {
    await listTemplateCatalog();
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as TemplateError).status).toBe(429);
  }
});

// ── the install: per-project, authenticated ────────────────────────────────

test('createTemplateInstallSession POSTs the slug with the token and returns the session', async () => {
  nextResponse = { status: 201, body: { session_id: 's1' } };
  const res = await createTemplateInstallSession('p1', 'seo-watch');
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/templates/install-session');
  expect(last().headers.authorization).toBe('Bearer tok');
  expect(last().body).toEqual({ slug: 'seo-watch' });
  expect(res.session_id).toBe('s1');
});

test('createTemplateInstallSession url-encodes the project id', async () => {
  nextResponse = { status: 201, body: { session_id: 's2' } };
  await createTemplateInstallSession('p/1', 'seo-watch');
  expect(last().url).toBe('http://test.local/projects/p%2F1/templates/install-session');
});

// ── the template's own repository ────────────────────────────────────────────
//
// A template IS a public repo pinned to a commit. The catalog says what it
// declares; these two reads say what it actually contains, which is what a
// person reads before installing it.

test('listTemplateFiles reads the file tree with no Authorization header', async () => {
  nextResponse = { status: 200, body: { files: [{ path: 'README.md', size: 12 }], default_path: 'README.md' } };
  const listing = await listTemplateFiles('seo-watch');
  expect(last().url).toBe('http://test.local/public/templates/seo-watch/files');
  expect(last().headers.authorization).toBeUndefined();
  expect(listing.files[0]?.path).toBe('README.md');
  expect(listing.default_path).toBe('README.md');
});

test('readTemplateFile sends the path as a query parameter and unwraps the text', async () => {
  nextResponse = { status: 200, body: { path: 'docs/a.md', content: '# hi' } };
  expect(await readTemplateFile('seo-watch', 'docs/a.md')).toBe('# hi');
  expect(last().url).toBe('http://test.local/public/templates/seo-watch/file?path=docs%2Fa.md');
});

test('readTemplateFile encodes a slug and a path with awkward characters', async () => {
  nextResponse = { status: 200, body: { path: 'a b/c#d.md', content: 'x' } };
  await readTemplateFile('a/b', 'a b/c#d.md');
  expect(last().url).toBe('http://test.local/public/templates/a%2Fb/file?path=a%20b%2Fc%23d.md');
});

test('readTemplateFile throws a TemplateError carrying 404 for an unpublished path', async () => {
  nextResponse = { status: 404, body: { error: 'File not found' } };
  await expect(readTemplateFile('seo-watch', 'nope.md')).rejects.toMatchObject({
    name: 'TemplateError',
    status: 404,
  });
});
