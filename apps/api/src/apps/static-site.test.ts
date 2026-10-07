import { describe, expect, test } from 'bun:test';
import { isNavigation, parseRange, resolveSitePath, siteCacheControl, siteContentType } from './static-site';

const site = new Set(['index.html', 'about.html', 'docs/index.html', 'assets/index-D8j1YYcB.js', 'logo.png', '404.html']);
const has = (path: string) => site.has(path);
const resolve = (path: string, spa = false, navigation = true) => resolveSitePath(path, has, { spa, navigation });

describe('resolveSitePath', () => {
  test('exact files, directory indexes and clean URLs', () => {
    expect(resolve('/')).toEqual({ path: 'index.html', status: 200 });
    expect(resolve('/logo.png')).toEqual({ path: 'logo.png', status: 200 });
    expect(resolve('/docs')).toEqual({ path: 'docs/index.html', status: 200 });
    expect(resolve('/docs/')).toEqual({ path: 'docs/index.html', status: 200 });
    expect(resolve('/about')).toEqual({ path: 'about.html', status: 200 });
    expect(resolve('/assets/index-D8j1YYcB.js')).toEqual({ path: 'assets/index-D8j1YYcB.js', status: 200 });
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
