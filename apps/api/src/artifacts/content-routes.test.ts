import { beforeEach, expect, mock, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';

const artifactId = '10000000-0000-4000-8000-000000000001';
const projectId = '10000000-0000-4000-8000-000000000002';
const csp = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
let row: Record<string, unknown> | null;
let storageAvailable = true;
const reads: Array<{ path: string; at: string | null; range: string | undefined }> = [];
const config = { ARTIFACT_CONTENT_URL: '' };
const files = new Map<string, string>();
class StorageError extends Error { constructor(readonly status: number) { super('File unavailable'); } }
const mime = (path: string) => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
mock.module('../config', () => ({ config }));
mock.module('../channels/core/signed-state', () => ({ verifyChannelState: (_purpose: string, token: string) => token === 'valid' ? { a: artifactId } : token === 'commit' ? { a: artifactId, c: 'vc-fixed' } : null }));
mock.module('../middleware/rate-limit', () => ({ createArtifactContentRateLimitMiddleware: () => (async (_c, next) => next()) as MiddlewareHandler }));
mock.module('../sandbox-proxy/routes/public-share', () => ({ PUBLIC_SHARE_SANDBOX_CSP: csp }));
mock.module('../drives/volumes', () => ({ DriveStorageError: StorageError, driveStorageAvailable: () => storageAvailable }));
mock.module('./formats', () => ({ renderDoc: (text: string) => `<html><body><article>${text}</article></body></html>` }));
mock.module('./service', () => ({
  artifactPrivateFolder: async () => null,
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
  storageAvailable = true; reads.length = 0; config.ARTIFACT_CONTENT_URL = '';
  files.clear(); files.set('index.html', '<!doctype html><p>Page-owned content</p>'); files.set('style.css', 'body{color:red}'); files.set('clip.mp4', 'media');
});

const signed = (path = 'index.html', query = '', token = 'valid', headers?: HeadersInit) => artifactContentApp.request(`http://api.example.test/s/${token}/${path}${query}`, { headers });

test('a page is served byte for byte with the sandbox CSP, its validators and no frame-ancestors; ?annotate=1 changes nothing', async () => {
  for (const query of ['', '?annotate=1']) {
    const response = await signed('index.html', query, 'commit');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(files.get('index.html')!);
    expect(response.headers.get('Content-Security-Policy')).toBe(csp);
    expect(response.headers.get('ETag')).toBe('"original"');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=3600');
  }
  expect(reads).toEqual([{ path: 'index.html', at: 'vc-fixed', range: undefined }, { path: 'index.html', at: 'vc-fixed', range: undefined }]);
});

test('a doc entry renders; CSS and media keep their Range reads', async () => {
  row!.type = 'doc'; row!.entry = 'report.md'; files.set('report.md', '# Report');
  expect(await (await signed('report.md')).text()).toContain('<article># Report</article>');
  row!.type = 'html'; row!.entry = 'index.html';
  for (const path of ['style.css', 'clip.mp4']) {
    const response = await signed(path, '', 'valid', { Range: 'bytes=0-3' });
    expect(response.status).toBe(206); expect(response.headers.has('Content-Range')).toBe(true);
    expect(response.headers.get('ETag')).toBe('"original"'); expect(await response.text()).toBe(files.get(path)!);
  }
});

test('an invalid token, a missing artifact and a Kortix without a Drive answer 404 without a read', async () => {
  expect((await signed('index.html', '', 'invalid')).status).toBe(404);
  row = null; expect((await signed()).status).toBe(404);
  row = { artifactId, projectId, type: 'html', entry: 'index.html', visibility: 'public' }; storageAvailable = false;
  expect((await signed()).status).toBe(404);
  expect((await artifactContentApp.request(`http://api.example.test/meta/${artifactId}`)).status).toBe(404);
  expect(reads).toHaveLength(0);
});

test('a public page and its metadata are served while a Drive is stored', async () => {
  const page = await artifactContentApp.request(`http://api.example.test/p/${artifactId}/index.html`);
  const meta = await artifactContentApp.request(`http://api.example.test/meta/${artifactId}`);
  expect(page.status).toBe(200); expect(await page.text()).toBe(files.get('index.html')!);
  expect(meta.status).toBe(200); expect((await meta.json()).artifact_id).toBe(artifactId);
});

test('the dedicated content origin adds allow-same-origin', async () => {
  config.ARTIFACT_CONTENT_URL = 'http://api.example.test';
  expect((await signed()).headers.get('Content-Security-Policy')).toBe(`${csp} allow-same-origin`);
});
