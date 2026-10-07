import { describe, expect, test } from 'bun:test';
import { isNavigation, parseRange, resolveSitePath, siteCacheControl, siteContentType } from './static-site';

const site = new Set(['index.html', 'about.html', 'docs/index.html', 'assets/index-D8j1YYcB.js', 'logo.png', '404.html']);
const has = (path: string) => site.has(path);
const resolve = (path: string, spa = false, navigation = true) => resolveSitePath(path, has, { spa, navigation });

describe('resolveSitePath', () => {
  test('exact files, directory indexes and clean URLs', () => {
    expect(resolve('/')).toEqual({ path: 'index.html', status: 200 });
    expect(resolve('/logo.png')).toEqual({ path: 'logo.png', status: 200 });
    expect(resolve('/docs')).toEqual({ redirect: '/docs/' });
    expect(resolve('/docs/')).toEqual({ path: 'docs/index.html', status: 200 });
    expect(resolve('/about')).toEqual({ path: 'about.html', status: 200 });
    expect(resolve('/assets/index-D8j1YYcB.js')).toEqual({ path: 'assets/index-D8j1YYcB.js', status: 200 });
  });

  test('a directory without its trailing slash redirects, built from the normalized path only', () => {
    const dirs = (path: string) => resolveSitePath(path, (p) => ['evil.test/index.html', 'a b/index.html'].includes(p), { spa: false, navigation: true });
    expect(dirs('//evil.test')).toEqual({ redirect: '/evil.test/' });
    expect(dirs('/a%20b')).toEqual({ redirect: '/a%20b/' });
    expect(dirs('/a%20b/')).toEqual({ path: 'a b/index.html', status: 200 });
  });

  test('a SPA serves its shell for page navigations, never for missing assets', () => {
    expect(resolve('/deals/42', true, true)).toEqual({ path: 'index.html', status: 200 });
    expect(resolve('/assets/missing.js', true, false)).toEqual({ path: '404.html', status: 404 });
  });

  test('a site without SPA mode answers 404.html with status 404', () => {
    expect(resolve('/nope')).toEqual({ path: '404.html', status: 404 });
  });

  test('nothing to serve: null', () => {
    const bare = (path: string) => resolveSitePath(path, (p) => p === 'index.html', { spa: false, navigation: true });
    expect(bare('/nope')).toBeNull();
  });

  test('traversal and malformed encodings never resolve', () => {
    for (const path of ['/../secret', '/a/../../b', '/%2e%2e/x', '/%E0%A4%A', '/a%00b']) {
      expect(resolveSitePath(path, () => true, { spa: true, navigation: true })).toBeNull();
    }
  });

  test('percent-encoded names resolve to the stored path', () => {
    expect(resolveSitePath('/my%20file.pdf', (p) => p === 'my file.pdf', { spa: false, navigation: false }))
      .toEqual({ path: 'my file.pdf', status: 200 });
  });
});

describe('isNavigation', () => {
  const req = (accept?: string) => new Request('https://app.test/', accept ? { headers: { accept } } : {});
  test('extensionless paths and HTML accepts are navigations; asset requests are not', () => {
    expect(isNavigation(req(), '/deals/42')).toBe(true);
    expect(isNavigation(req('text/html,application/xhtml+xml'), '/v1.2')).toBe(true);
    expect(isNavigation(req('*/*'), '/app.js')).toBe(false);
  });
});

describe('siteCacheControl', () => {
  test('HTML always revalidates', () => {
    expect(siteCacheControl('index.html', true)).toBe('public, no-cache');
  });
  test('hashed build output is immutable for a year', () => {
    for (const path of [
      'assets/index-D8j1YYcB.js',
      'assets/style.4fA9kQ2z.css',
      'assets/index-4f3a9c1b.js',
      'app/assets/vendor-DiwrgTda.js',
      'static/css/main.a1b2c3d4.css',
      'static/js/787.f5c2e1a9.chunk.js',
      '_next/static/chunks/main.js',
    ]) {
      expect(siteCacheControl(path, true)).toBe('public, max-age=31536000, immutable');
    }
  });
  test('names that only look long are not treated as hashed', () => {
    for (const path of [
      'my-component.js',
      'logo.png',
      'assets/background.jpg',
      'assets/logo-original.png',
      'assets/jquery-3.6.0.min.js',
      'jquery-3.6.0.min.js',
      'img/team-Photo2024.jpg',
      'docs/Report-Q3Final2.pdf',
      'main.a1b2c3d4.css',
    ]) {
      expect(siteCacheControl(path, true)).toBe('public, max-age=0, must-revalidate');
    }
  });
  test('a non-public App is never cacheable by shared caches', () => {
    expect(siteCacheControl('assets/index-D8j1YYcB.js', false)).toBe('private, max-age=31536000, immutable');
    expect(siteCacheControl('index.html', false)).toBe('private, no-cache');
  });
});

describe('parseRange', () => {
  test('single ranges, suffix ranges, and refusals', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-9', 100)).toBeNull();
  });
});

describe('siteContentType', () => {
  test('text types carry a charset', () => {
    expect(siteContentType('index.html')).toContain('text/html');
    expect(siteContentType('index.html')).toContain('charset=utf-8');
    expect(siteContentType('app.js')).toContain('javascript');
    expect(siteContentType('blob.unknownext')).toBe('application/octet-stream');
  });
});

describe('chooseEncoding', () => {
  test('Brotli first, then gzip; small files and binaries stay identity', async () => {
    const { chooseEncoding } = await import('./static-site');
    expect(chooseEncoding('gzip, deflate, br', 'text/javascript; charset=utf-8', 5000)).toBe('br');
    expect(chooseEncoding('gzip', 'text/html; charset=utf-8', 5000)).toBe('gzip');
    expect(chooseEncoding('gzip, br', 'image/svg+xml', 5000)).toBe('br');
    expect(chooseEncoding('gzip, br', 'image/png', 5000)).toBeNull();
    expect(chooseEncoding('gzip, br', 'text/css', 200)).toBeNull();
    expect(chooseEncoding(null, 'text/css', 5000)).toBeNull();
  });
});

describe('compression bounds', () => {
  test('a body over the in-memory compression limit is served as identity', async () => {
    const { chooseEncoding, MAX_COMPRESS_BYTES } = await import('./static-site');
    expect(chooseEncoding('br, gzip', 'text/plain; charset=utf-8', MAX_COMPRESS_BYTES)).toBe('br');
    expect(chooseEncoding('br, gzip', 'text/plain; charset=utf-8', MAX_COMPRESS_BYTES + 1)).toBeNull();
    expect(chooseEncoding('gzip', 'application/json', 50 * 1024 * 1024)).toBeNull();
  });

  test('the compressed-body cache stays under its byte budget', async () => {
    const { encodeSiteBody, siteCaches, resetStaticSiteCaches, MAX_COMPRESS_BYTES } = await import('./static-site');
    const { randomBytes } = await import('node:crypto');
    const { gunzipSync } = await import('node:zlib');
    resetStaticSiteCaches();
    const budget = siteCaches.encoded.budget;
    // Random bytes do not compress: each entry stays close to its input size.
    const count = Math.ceil(budget / MAX_COMPRESS_BYTES) + 2;
    const body = new Uint8Array(randomBytes(MAX_COMPRESS_BYTES));
    for (let i = 0; i < count; i += 1) {
      const out = await encodeSiteBody(`sha-${i}`, 'gzip', body);
      expect(gunzipSync(out).byteLength).toBe(body.byteLength);
    }
    expect(siteCaches.encoded.bytes).toBeGreaterThan(0);
    expect(siteCaches.encoded.bytes).toBeLessThanOrEqual(budget);
    resetStaticSiteCaches();
  });
});

describe('ByteLru', () => {
  test('evicts the least recently used entries by total bytes and never keeps an oversized value', async () => {
    const { ByteLru } = await import('./static-site');
    const cache = new ByteLru<string>(100);
    cache.set('a', 'a', 40);
    cache.set('b', 'b', 40);
    expect(cache.get('a')).toBe('a'); // a is now the most recent
    cache.set('c', 'c', 40);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('a');
    expect(cache.bytes).toBe(80);
    cache.set('a', 'a2', 10);
    expect(cache.bytes).toBe(50);
    cache.set('huge', 'huge', 101);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.bytes).toBe(50);
  });
});

describe('static error responses', () => {
  test('405 carries the Cloudflare no-store header', async () => {
    const { serveStaticDeployment } = await import('./static-site');
    const response = await serveStaticDeployment({
      request: new Request('https://app.test/', { method: 'POST' }),
      url: new URL('https://app.test/'),
      accountId: '00000000-0000-4000-a000-000000000001',
      deploymentId: '00000000-0000-4000-a000-000000000002',
      spa: false,
      publicApp: true,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('publishStaticSite containment', () => {
  test('a static root reached through a symlinked directory is refused before any file is read', async () => {
    const { publishStaticSite } = await import('./static-site');
    const { mkdtemp, mkdir, rm, symlink, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outside = await mkdtemp(join(tmpdir(), 'kortix-static-outside-'));
    const source = await mkdtemp(join(tmpdir(), 'kortix-static-source-'));
    try {
      await mkdir(join(outside, 'site'));
      await writeFile(join(outside, 'site', 'secret.txt'), 'host file');
      await symlink(outside, join(source, 'link'));
      const reads: string[] = [];
      await expect(publishStaticSite({
        deploymentId: '00000000-0000-4000-a000-000000000002',
        accountId: '00000000-0000-4000-a000-000000000001',
        sourceDir: source,
        root: 'link/site',
        storage: { put: async (key) => { reads.push(key); }, open: async () => null, remove: async () => {} },
      })).rejects.toThrow(/static root resolves outside the artifact/);
      expect(reads).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('serveStaticDeployment against a fake storage', () => {
  const ACCOUNT = '00000000-0000-4000-a000-000000000011';
  const DEPLOYMENT = '00000000-0000-4000-a000-000000000012';
  const MIB = 1024 * 1024;

  async function setup() {
    const { siteCaches, resetStaticSiteCaches, blobKey } = await import('./static-site');
    resetStaticSiteCaches();
    const large = new Uint8Array(5 * MIB).map((_, i) => 97 + (i % 26));
    const small = new TextEncoder().encode('<!doctype html><link rel=stylesheet href=style.css>');
    const files = [
      { path: 'data.json', sha256: 'a'.repeat(64), sizeBytes: large.byteLength, contentType: 'application/json' },
      { path: 'docs/index.html', sha256: 'b'.repeat(64), sizeBytes: small.byteLength, contentType: 'text/html; charset=utf-8' },
    ];
    siteCaches.manifests.set(DEPLOYMENT, new Map(files.map((file) => [file.path, file])), 1);
    const objects = new Map([[blobKey(ACCOUNT, 'a'.repeat(64)), large], [blobKey(ACCOUNT, 'b'.repeat(64)), small]]);
    const opens: Array<{ key: string; range?: { start: number; end: number } }> = [];
    let fail = false;
    const storage = {
      put: async () => {},
     
      remove: async () => {},
      open: async (key: string, range?: { start: number; end: number }) => {
        opens.push({ key, range });
        if (fail) throw new Error('storage down');
        const bytes = objects.get(key);
        if (!bytes) return null;
        const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
        return new Blob([slice]).stream();
      },
    };
    const { serveStaticDeployment } = await import('./static-site');
    const serve = (path: string, init: RequestInit = {}) => serveStaticDeployment({
      request: new Request(`https://app.test${path}`, init),
      url: new URL(`https://app.test${path}`),
      accountId: ACCOUNT,
      deploymentId: DEPLOYMENT,
      spa: false,
      publicApp: true,
      storage,
    });
    return { serve, opens, large, setFail: (value: boolean) => { fail = value; } };
  }

  test('a 5 MiB text file streams uncompressed with its exact length', async () => {
    const { serve, opens, large } = await setup();
    const response = await serve('/data.json', { headers: { 'accept-encoding': 'br, gzip' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(large.byteLength));
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(large);
    expect(opens).toEqual([{ key: `${ACCOUNT}/${'a'.repeat(64)}`, range: undefined }]);
  });

  test('a range on a large file asks storage for only those bytes', async () => {
    const { serve, opens, large } = await setup();
    const response = await serve('/data.json', { headers: { range: 'bytes=1048576-1048585' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 1048576-1048585/${large.byteLength}`);
    expect(response.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(large.subarray(1048576, 1048586));
    expect(opens[0]!.range).toEqual({ start: 1048576, end: 1048585 });
  });

  test('HEAD answers from the manifest and reads no blob', async () => {
    const { serve, opens, large } = await setup();
    const response = await serve('/data.json', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(large.byteLength));
    expect(opens).toEqual([]);
  });

  test('a directory URL without a slash redirects 308 and keeps the query', async () => {
    const { serve, opens } = await setup();
    const response = await serve('/docs?tab=2');
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/docs/?tab=2');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(opens).toEqual([]);
    expect((await serve('/docs/')).status).toBe(200);
  });

  test('a 304 carries vary: accept-encoding', async () => {
    const { serve } = await setup();
    const response = await serve('/docs/', { headers: { 'if-none-match': `W/"${'b'.repeat(64)}"` } });
    expect(response.status).toBe(304);
    expect(response.headers.get('vary')).toBe('accept-encoding');
  });

  test('a storage failure answers 503 with retry-after', async () => {
    const { serve, setFail } = await setup();
    setFail(true);
    const response = await serve('/data.json');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });
});

