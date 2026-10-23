import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { type safeEgressFetch, UnsafeEgressError } from '../../shared/ssrf-guard';
import { fetchLinkMeta, needsUnfurl, parseLinkMeta, UNFURL_MAX_BYTES, UNFURL_TIMEOUT_MS, unfurlLink } from './link-unfurl';
import { linkPathTitle } from './project-space-links';

const BASE = 'https://northwind.example/docs/pricing';

describe('parseLinkMeta', () => {
  test('og:title wins over <title>; entities are decoded and whitespace collapsed', () => {
    const html = `<html><head><title>Ignored</title>
      <meta property="og:title" content="Q4 &amp; launch &#8212; &#x2713; &quot;plan&quot;">
      <meta property='og:site_name' content='Northwind&nbsp;Docs'></head><body><title>body</title></body></html>`;
    expect(parseLinkMeta(html, BASE)).toEqual({
      title: 'Q4 & launch — ✓ "plan"',
      siteName: 'Northwind Docs',
      iconUrl: null,
    });
  });

  test('<title> is used without og:title; missing tags answer null', () => {
    expect(parseLinkMeta('<head><TITLE>\n  Acme   pricing &lt;2026&gt;\n</TITLE></head>', BASE)).toEqual({
      title: 'Acme pricing <2026>',
      siteName: null,
      iconUrl: null,
    });
    expect(parseLinkMeta('', BASE)).toEqual({ title: null, siteName: null, iconUrl: null });
    expect(parseLinkMeta('<title></title>', BASE).title).toBeNull();
  });

  test('a relative icon resolves against the page; rel=icon wins over apple-touch-icon', () => {
    const html = '<link rel="apple-touch-icon" href="/touch.png"><link href="../img/fav.ico" rel="shortcut icon">';
    expect(parseLinkMeta(html, BASE).iconUrl).toBe('https://northwind.example/img/fav.ico');
    expect(parseLinkMeta('<link rel=apple-touch-icon href=//cdn.example/t.png>', BASE).iconUrl).toBe(
      'https://cdn.example/t.png',
    );
  });

  test('a non-http(s) icon is dropped', () => {
    expect(parseLinkMeta('<link rel="icon" href="javascript:alert(1)">', BASE).iconUrl).toBeNull();
    expect(parseLinkMeta('<link rel="icon" href="data:image/png;base64,AAAA">', BASE).iconUrl).toBeNull();
  });

  test('stored text is plain: no tags, control, bidi or zero-width characters', () => {
    const meta = parseLinkMeta(
      '<title>&lt;script&gt;alert(1)&lt;/script&gt; <b>Acme</b> &#x202E;Ev\u200Bil\u0007&#xD800;&#x2066;!</title>' +
        '<meta property="og:site_name" content="North&#x200F;wind&#0;\u0000">',
      BASE,
    );
    expect(meta.title).toBe('alert(1) Acme Evil!');
    expect(meta.siteName).toBe('Northwind&#0;');
    expect(parseLinkMeta('<title>Acme pricing &lt;2026&gt; &amp; 1 &lt; 2</title>', BASE).title).toBe('Acme pricing <2026> & 1 < 2');
  });

  test('tags after the head are not read', () => {
    expect(parseLinkMeta('<head></head><body><meta property="og:title" content="x"></body>', BASE).title).toBeNull();
  });

  test('a crafted page of the full read size parses in linear time', () => {
    const crafted = ['<meta'.repeat(UNFURL_MAX_BYTES / 5), `<link ${'a'.repeat(UNFURL_MAX_BYTES)}`, `<meta ${'a='.repeat(500)}>`.repeat(400)];
    for (const html of crafted) {
      const start = performance.now();
      parseLinkMeta(html, BASE);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });
});

describe('fetchLinkMeta', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  test.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8008/v1/health',
    'http://10.0.0.5/',
    'file:///etc/passwd',
  ])('refuses %s before any request', async (url) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('');
    }) as unknown as typeof fetch;
    await expect(fetchLinkMeta(url)).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(calls).toBe(0);
  });

  test('refuses a port other than 80/443 before any request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('');
    }) as unknown as typeof fetch;
    await expect(fetchLinkMeta('http://93.184.216.34:6379/')).rejects.toBeInstanceOf(UnsafeEgressError);
    await expect(fetchLinkMeta('https://93.184.216.34:8443/')).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(calls).toBe(0);
  });

  test.each([
    ['https://93.184.216.34/start', 'http://93.184.216.34/plain'],
    ['http://93.184.216.34/start', 'http://93.184.216.34:8080/admin'],
  ])('refuses the redirect %s → %s', async (from, to) => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: to } });
    }) as unknown as typeof fetch;
    await expect(fetchLinkMeta(from)).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(seen).toEqual([from]);
  });

  test('refuses a redirect to a private address', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8008/v1/health' } });
    }) as unknown as typeof fetch;
    await expect(fetchLinkMeta('http://93.184.216.34/start')).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(seen).toEqual(['http://93.184.216.34/start']);
  });

  test('stops after 3 redirects', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: `http://93.184.216.34/${calls}` } });
    }) as unknown as typeof fetch;
    await expect(fetchLinkMeta('http://93.184.216.34/')).rejects.toThrow('too many redirects');
    expect(calls).toBe(4);
  });

  test('sends a clear User-Agent, no cookie, and reads the page', async () => {
    let headers: Headers | null = null;
    globalThis.fetch = (async (_input: string | URL, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('<title>Acme</title><link rel="icon" href="/f.ico"><link rel="x" href="http://10.0.0.1/">', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof fetch;
    expect(await fetchLinkMeta('https://93.184.216.34/page')).toEqual({
      title: 'Acme',
      siteName: null,
      iconUrl: 'https://93.184.216.34/f.ico',
    });
    expect(headers!.get('user-agent')).toContain('KortixLinkPreview');
    expect(headers!.get('cookie')).toBeNull();
    expect(headers!.get('authorization')).toBeNull();
  });

  test.each(['http://169.254.169.254/i.ico', 'https://[::1]/i.ico', 'http://93.184.216.34/i.ico', 'https://93.184.216.34:8443/i.ico'])(
    'the icon %s is not stored (https on 443 and a public address only)',
    async (icon) => {
      globalThis.fetch = (async () =>
        new Response(`<title>Acme</title><link rel="icon" href="${icon}">`, {
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch;
      expect((await fetchLinkMeta('http://93.184.216.34/')).iconUrl).toBeNull();
    },
  );

  test('a page that is not HTML answers no title; a non-2xx answer fails', async () => {
    globalThis.fetch = (async () =>
      new Response('%PDF-1.7 <title>x</title>', { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    expect(await fetchLinkMeta('http://93.184.216.34/a.pdf')).toEqual({ title: null, siteName: null, iconUrl: null });
    globalThis.fetch = (async () => new Response('<title>Gone</title>', { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(fetchLinkMeta('http://93.184.216.34/gone')).rejects.toThrow('status 404');
  });

  test('reads at most 256 KB of the body', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`<!-- ${'x'.repeat(64 * 1024 - 9)} -->`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(pulled === chunk.byteLength ? new TextEncoder().encode('<title>Big</title>') : chunk);
      },
    });
    globalThis.fetch = (async () => new Response(body, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect((await fetchLinkMeta('http://93.184.216.34/big')).title).toBe('Big');
    expect(pulled).toBeLessThanOrEqual(UNFURL_MAX_BYTES + 2 * chunk.byteLength);
  });

  test('gives up after 5 s (fake clock)', async () => {
    jest.useFakeTimers();
    let aborted = false;
    const never = ((_url: string, init: RequestInit) =>
      new Promise<Response>(() => {
        init.signal?.addEventListener('abort', () => (aborted = true));
      })) as unknown as typeof safeEgressFetch;
    const result = fetchLinkMeta('http://93.184.216.34/slow', { fetch: never });
    let settled = false;
    result.catch(() => {}).finally(() => (settled = true));
    jest.advanceTimersByTime(UNFURL_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(result).rejects.toThrow('timed out');
    expect(aborted).toBe(true);
  });
});

describe('needsUnfurl', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (hours: number) => new Date(now - hours * 3_600_000);
  test('fetched within 7 days or failed within 24 h: no fetch', () => {
    expect(needsUnfurl({ fetchedAt: null, fetchFailedAt: null }, now)).toBe(true);
    expect(needsUnfurl({ fetchedAt: ago(24 * 6), fetchFailedAt: null }, now)).toBe(false);
    expect(needsUnfurl({ fetchedAt: ago(24 * 7 + 1), fetchFailedAt: null }, now)).toBe(true);
    expect(needsUnfurl({ fetchedAt: null, fetchFailedAt: ago(23) }, now)).toBe(false);
    expect(needsUnfurl({ fetchedAt: null, fetchFailedAt: ago(25) }, now)).toBe(true);
  });
});

describe('linkPathTitle', () => {
  test('the decoded path, else the host', () => {
    expect(linkPathTitle('https://acme.example/file/Pricing%20page/')).toBe('file/Pricing page');
    expect(linkPathTitle('https://en.wiki.example/wiki/C++?q=a+b')).toBe('wiki/C++?q=a b');
    expect(linkPathTitle('https://www.acme.example/')).toBe('acme.example');
    expect(linkPathTitle('https://acme.example/%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('unfurlLink', () => {
  test('a database error never carries the URL into the queue log', async () => {
    const secretUrl = 'https://acme.example/private/Priya-offer';
    const results: Array<() => unknown> = [
      () => [{ projectId: 'p', url: secretUrl, fetchedAt: null, fetchFailedAt: null }],
      () => {
        throw new Error(`Failed query: select … params: p,${secretUrl}`);
      },
    ];
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'from', 'where', 'update', 'set']) chain[name] = () => chain;
    chain.limit = async () => results.shift()!();
    mock.module('../../shared/db', () => ({ db: chain }));
    const error = await unfurlLink('11111111-1111-4111-8111-111111111111').then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('acme.example');
    expect(String(error)).toContain('link unfurl');
  });
});
