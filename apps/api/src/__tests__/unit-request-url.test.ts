import { describe, expect, it } from 'bun:test';

import { ensureAbsoluteRequestUrl, getRequestUrl, isRelativeRequestUrl } from '../lib/request-url';

describe('getRequestUrl', () => {
  it('returns absolute Bun request URLs unchanged', () => {
    const req = new Request('http://localhost:8008/v1/health?check=1');
    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('http://localhost:8008/v1/health?check=1');
  });

  it('normalizes relative Bun request URLs using host header', () => {
    const req = new Request('http://placeholder.invalid', {
      headers: { host: 'api.kortix.com' },
    });
    Object.defineProperty(req, 'url', { value: '/', configurable: true });

    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('http://api.kortix.com/');
  });

  it('prefers forwarded proto and host when present', () => {
    const req = new Request('http://placeholder.invalid', {
      headers: {
        host: 'internal:8008',
        'x-forwarded-host': 'kortix.com',
        'x-forwarded-proto': 'https',
      },
    });
    Object.defineProperty(req, 'url', { value: '/status?full=1', configurable: true });

    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('https://kortix.com/status?full=1');
  });

  // ── Regression: BS pattern 28e9a65c… — path-only req.url from no-Host
  // scanner probes (HTTP/1.0 `GET /`, Trinity fingerprint
  // `/nice%20ports%2C/Tri%6Eity.txt%2ebak`). Bun.serve sets `req.url` to a
  // path-only string when there is no Host header, which made downstream
  // `new URL(c.req.url)` throw `TypeError: "…" cannot be parsed as a URL.`
  // → Sentry. The fix rebuilds the Request with an absolute URL at the
  // Bun.serve boundary.
  describe('ensureAbsoluteRequestUrl (BS 28e9a65c…)', () => {
    it('rebuilds a path-only "/" request with the fallback host', () => {
      const req = new Request('http://placeholder.invalid');
      Object.defineProperty(req, 'url', { value: '/', configurable: true });

      const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

      expect(rebuilt).not.toBe(req);
      expect(isRelativeRequestUrl(rebuilt)).toBe(false);
      expect(rebuilt.url).toBe('http://localhost:8008/');
      // new URL() on the rebuilt URL must not throw — that's the whole point.
      expect(new URL(rebuilt.url).toString()).toBe('http://localhost:8008/');
    });

    it('rebuilds a path-only Trinity scanner fingerprint with the fallback host', () => {
      const req = new Request('http://placeholder.invalid');
      Object.defineProperty(req, 'url', {
        value: '/nice%20ports%2C/Tri%6Eity.txt%2ebak',
        configurable: true,
      });

      const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

      expect(isRelativeRequestUrl(rebuilt)).toBe(false);
      expect(rebuilt.url).toBe(
        'http://localhost:8008/nice%20ports%2C/Tri%6Eity.txt%2ebak',
      );
    });

    it('preserves host header and forwarded-proto when rebuilding', () => {
      const req = new Request('http://placeholder.invalid', {
        headers: {
          host: 'api.kortix.com',
          'x-forwarded-proto': 'https',
        },
      });
      Object.defineProperty(req, 'url', { value: '/v1/health', configurable: true });

      const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

      expect(rebuilt.url).toBe('https://api.kortix.com/v1/health');
      // Headers preserved (the rebuilt Request keeps the original headers).
      expect(rebuilt.headers.get('host')).toBe('api.kortix.com');
    });

    it('preserves method, body, and headers when rebuilding', () => {
      const req = new Request('http://placeholder.invalid', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'x' },
        body: JSON.stringify({ a: 1 }),
      });
      Object.defineProperty(req, 'url', { value: '/v1/foo', configurable: true });

      const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

      expect(rebuilt.method).toBe('POST');
      expect(rebuilt.headers.get('content-type')).toBe('application/json');
      // Body survives the rebuild (Request constructor re-streams it).
      return expect(rebuilt.text()).resolves.toBe('{"a":1}');
    });

    it('is a no-op for an already-absolute request URL (no rebuild, same instance)', () => {
      const req = new Request('http://api.kortix.com/v1/health');

      const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

      expect(rebuilt).toBe(req);
      expect(isRelativeRequestUrl(req)).toBe(false);
    });

    it('every downstream new URL(c.req.url) call site is now safe', () => {
      // The exact call-site shape used across the codebase
      // (auth middleware, OpenAPI server URL, proxy handlers, …):
      //   const url = new URL(c.req.url);
      // For a path-only "/" that throws pre-fix; post-fix it must not.
      for (const pathOnly of ['/', '/v1/health', '/nice%20ports%2C/Tri%6Eity.txt%2ebak']) {
        const req = new Request('http://placeholder.invalid');
        Object.defineProperty(req, 'url', { value: pathOnly, configurable: true });

        const rebuilt = ensureAbsoluteRequestUrl(req, 8008);

        // This must not throw for any path-only input Bun.serve can produce.
        expect(() => new URL(rebuilt.url)).not.toThrow();
      }
    });
  });
});
