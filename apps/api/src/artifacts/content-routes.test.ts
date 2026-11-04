import { beforeEach, expect, mock, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';
import { createArtifactAnnotationInjector } from './annotation-injection';

const artifactId = '10000000-0000-4000-8000-000000000001';
const projectId = '10000000-0000-4000-8000-000000000002';
const csp = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const source = 'globalThis.annotationBridgeReady=true;';
let row: Record<string, unknown> | null;
let flags: Record<string, boolean>;
let failBuild = false;
let injections = 0;
const reads: Array<{ path: string; at: string | null; range: string | undefined }> = [];
const flagReads: string[] = [];
const config = { ARTIFACT_CONTENT_URL: '' };
const files = new Map<string, string>();
class StorageError extends Error { constructor(readonly status: number) { super('File unavailable'); } }
const mime = (path: string) => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
mock.module('../config', () => ({ config }));
mock.module('../channels/core/signed-state', () => ({ verifyChannelState: (_purpose: string, token: string) => token === 'valid' ? { a: artifactId } : token === 'commit' ? { a: artifactId, c: 'vc-fixed' } : null }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async (_project: string, flag: string) => { flagReads.push(flag); return flags[flag] ?? false; } }));
mock.module('../middleware/rate-limit', () => ({ createArtifactContentRateLimitMiddleware: () => (async (_c, next) => next()) as MiddlewareHandler }));
mock.module('../sandbox-proxy/routes/public-share', () => ({ PUBLIC_SHARE_SANDBOX_CSP: csp }));
mock.module('../drives/volumes', () => ({ DriveStorageError: StorageError }));
mock.module('./formats', () => ({ renderDoc: (text: string) => `<html><body><article>${text}</article></body></html>` }));
mock.module('./annotation-injection', () => ({
  createArtifactAnnotationInjector,
  injectArtifactAnnotations: async (response: Response) => {
    injections++;
    return createArtifactAnnotationInjector(async () => { if (failBuild) throw new Error('Build failed'); return source; })(response);
  },
}));
mock.module('./service', () => ({
  ARTIFACTS_FLAG: 'artifacts', artifactPrivateFolder: async () => null,
  artifactPublicContentUrl: (id: string) => `https://content.example.test/p/${id}/`, contentTypeFor: mime,
  getArtifactById: async () => row, normalizeArtifactPath: (path: string) => path,
  readArtifactFile: async (_row: unknown, path: string, at: string | null, range?: string) => {
    reads.push({ path, at, range });
    if (!files.has(path)) throw new StorageError(404);
    const body = files.get(path)!;
    return new Response(body, { status: range ? 206 : 200, headers: {
      'Content-Length': String(body.length), 'Content-Type': mime(path), ETag: '"original"',
      'Last-Modified': 'Thu, 29 Oct 2026 00:00:00 GMT', ...(range ? { 'Content-Range': `bytes 0-${body.length - 1}/${body.length}` } : {}),
    } });
  },
}));
const { artifactContentApp, registerArtifactContentRoutes } = await import('./content-routes');
registerArtifactContentRoutes();

beforeEach(() => {
  row = { artifactId, projectId, entry: 'index.html', type: 'html', visibility: 'public', title: 'Page', description: null, updatedAt: new Date('2026-10-29T00:00:00Z') };
  flags = { artifacts: true, artifact_comments: true };
  failBuild = false; injections = 0; reads.length = 0; flagReads.length = 0; config.ARTIFACT_CONTENT_URL = '';
  files.clear(); files.set('index.html', '<!doctype html><p>Page-owned content</p>'); files.set('style.css', 'body{color:red}'); files.set('clip.mp4', 'media'); files.set('nested/index.html', '<p>Nested page</p>');
});

const signed = (path = 'index.html', query = '?annotate=1', token = 'valid', headers?: HeadersInit) => artifactContentApp.request(`http://api.example.test/s/${token}/${path}${query}`, { headers });

test('the signed trailing-slash redirect retains the annotation opt-in', async () => {
  const response = await artifactContentApp.request('http://api.example.test/s/valid?annotate=1');
  expect(response.status).toBe(301);
  expect(response.headers.get('Location')).toBe('/s/valid/?annotate=1');
});

test('only signed HTML opt-in is annotated with identical CSP and invalidated source validators', async () => {
  const normal = await signed('index.html', '', 'commit');
  const annotated = await signed('index.html', '?annotate=1', 'commit', { Range: 'bytes=0-3' });
  expect(await normal.text()).not.toContain('kortix-annotate.js');
  expect(await annotated.text()).toContain(`<script id="kortix-annotate.js">${source}</script>`);
  expect(annotated.status).toBe(200);
  expect(annotated.headers.get('Content-Security-Policy')).toBe(normal.headers.get('Content-Security-Policy'));
  expect(annotated.headers.get('Cache-Control')).toBe('private, no-store');
  expect(normal.headers.get('ETag')).toBe('"original"');
  expect(normal.headers.get('Cache-Control')).toBe('private, max-age=3600');
  for (const name of ['Content-Length', 'ETag', 'Last-Modified', 'Accept-Ranges', 'Content-Range']) expect(annotated.headers.has(name)).toBe(false);
  expect(reads).toEqual([{ path: 'index.html', at: 'vc-fixed', range: undefined }, { path: 'index.html', at: 'vc-fixed', range: undefined }]);
  expect(injections).toBe(1);
});

test('public pages and metadata never inject or read the comments flag', async () => {
  const page = await artifactContentApp.request(`http://api.example.test/p/${artifactId}/index.html?annotate=1`);
  const meta = await artifactContentApp.request(`http://api.example.test/meta/${artifactId}?annotate=1`);
  expect(page.status).toBe(200); expect(await page.text()).not.toContain('kortix-annotate.js');
  expect(meta.status).toBe(200); expect((await meta.json()).artifact_id).toBe(artifactId);
  expect(injections).toBe(0); expect(flagReads).not.toContain('artifact_comments');
});

test('comments flag off and nonliteral opt-ins preserve normal HTML responses', async () => {
  flags.artifact_comments = false;
  expect(await (await signed()).text()).not.toContain('kortix-annotate.js');
  flags.artifact_comments = true;
  for (const query of ['', '?annotate=0', '?annotate=true']) expect(await (await signed('index.html', query)).text()).not.toContain('kortix-annotate.js');
  expect(injections).toBe(0);
});

test('docs and ranged CSS or media keep their existing content contracts', async () => {
  row!.type = 'doc'; row!.entry = 'report.md'; files.set('report.md', '# Report');
  expect(await (await signed('report.md')).text()).toContain('<article># Report</article>');
  row!.type = 'html'; row!.entry = 'index.html';
  for (const path of ['style.css', 'clip.mp4']) {
    const response = await signed(path, '?annotate=1', 'valid', { Range: 'bytes=0-3' });
    expect(response.status).toBe(206); expect(response.headers.has('Content-Range')).toBe(true);
    expect(response.headers.get('ETag')).toBe('"original"'); expect(await response.text()).toBe(files.get(path)!);
  }
  expect(injections).toBe(0);
});

test('nested HTML resolved from an extensionless path reads a full file before injection', async () => {
  const response = await signed('nested', '?annotate=1', 'valid', { Range: 'bytes=0-3' });
  expect(response.status).toBe(200); expect(await response.text()).toContain('kortix-annotate.js');
  expect(reads).toEqual([{ path: 'nested', at: null, range: undefined }, { path: 'nested/index.html', at: null, range: undefined }]);
});

test('invalid signed tokens, unavailable artifacts, and disabled Artifacts never build a bridge', async () => {
  expect((await signed('index.html', '?annotate=1', 'invalid')).status).toBe(404);
  row = null; expect((await signed()).status).toBe(404);
  row = { artifactId, projectId, type: 'html', entry: 'index.html' }; flags.artifacts = false;
  expect((await signed()).status).toBe(404); expect(reads).toHaveLength(0); expect(injections).toBe(0);
});

test('build failure returns annotation-only 503 without changing normal or public views', async () => {
  failBuild = true;
  const response = await signed();
  expect(response.status).toBe(503); expect(response.headers.get('Content-Security-Policy')).toBe(csp);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.text()).toBe('Artifact annotations are unavailable');
  expect((await signed('index.html', '')).status).toBe(200);
  expect((await artifactContentApp.request(`http://api.example.test/p/${artifactId}/index.html?annotate=1`)).status).toBe(200);
});

test('dedicated content-origin CSP is byte-identical with and without annotation', async () => {
  config.ARTIFACT_CONTENT_URL = 'http://api.example.test';
  const normal = await signed('index.html', ''); const annotated = await signed();
  expect(normal.headers.get('Content-Security-Policy')).toBe(`${csp} allow-same-origin`);
  expect(annotated.headers.get('Content-Security-Policy')).toBe(normal.headers.get('Content-Security-Policy'));
});
