import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let dnsResults: Record<string, Array<{ address: string; family: number }>> = {};
mock.module('node:dns/promises', () => ({
  lookup: async (host: string) => dnsResults[host] ?? [],
}));

const { assertSafeUrl, boundedFetch, FetchTimeoutError, isUnsafeUrlError } = await import(
  './safe-fetch'
);

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function hangingStream(signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (signal?.aborted) {
        controller.error(abortError());
        return;
      }
      signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
    },
  });
}

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let nextResponse: (init?: RequestInit) => Response = () =>
  new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
const realFetch = globalThis.fetch;

beforeEach(() => {
  dnsResults = { 'example.com': PUBLIC, 'evil.com': [{ address: '169.254.169.254', family: 4 }] };
  fetchCalls = [];
  nextResponse = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (init?.signal?.aborted) throw abortError();
    return nextResponse(init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('assertSafeUrl', () => {
  test('accepts a public host', async () => {
    const url = await assertSafeUrl('https://example.com/about');
    expect(url.hostname).toBe('example.com');
  });

  test('rejects a host resolving to the cloud metadata address', async () => {
    await expect(assertSafeUrl('https://evil.com')).rejects.toThrow();
  });

  test('rejects a literal loopback address without issuing dns', async () => {
    await expect(assertSafeUrl('https://127.0.0.1/')).rejects.toThrow();
  });

  test('rejects plain http', async () => {
    await expect(assertSafeUrl('http://example.com')).rejects.toThrow();
  });

  test('flags guard rejections as unsafe-url errors', async () => {
    try {
      await assertSafeUrl('https://evil.com');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(isUnsafeUrlError(err)).toBe(true);
    }
  });
});

describe('boundedFetch', () => {
  test('returns the body for a public url', async () => {
    const res = await boundedFetch('https://example.com/');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toBe('ok');
    expect(res.truncated).toBe(false);
  });

  test('never issues a request for a blocked host', async () => {
    await expect(boundedFetch('https://evil.com/')).rejects.toThrow();
    expect(fetchCalls).toHaveLength(0);
  });

  test('returns non-2xx statuses instead of throwing', async () => {
    nextResponse = () => new Response('forbidden', { status: 403 });
    const res = await boundedFetch('https://example.com/');
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
  });

  test('truncates a body larger than the cap', async () => {
    nextResponse = () => new Response(streamOf(['a'.repeat(100), 'b'.repeat(100)]), { status: 200 });
    const res = await boundedFetch('https://example.com/', { maxBytes: 50 });
    expect(res.truncated).toBe(true);
    expect(res.body).toHaveLength(50);
    expect(res.body).toBe('a'.repeat(50));
  });

  test('does not mark an exactly-sized body as truncated', async () => {
    nextResponse = () => new Response(streamOf(['abcde']), { status: 200 });
    const res = await boundedFetch('https://example.com/', { maxBytes: 1000 });
    expect(res.truncated).toBe(false);
    expect(res.body).toBe('abcde');
  });

  test('reassembles a body split across chunks', async () => {
    nextResponse = () => new Response(streamOf(['hello ', 'world']), { status: 200 });
    const res = await boundedFetch('https://example.com/', { maxBytes: 1000 });
    expect(res.body).toBe('hello world');
  });

  test('throws a typed timeout when the body never arrives', async () => {
    nextResponse = (init) => new Response(hangingStream(init?.signal ?? undefined), { status: 200 });
    await expect(boundedFetch('https://example.com/', { timeoutMs: 25 })).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );
  });

  test('propagates the caller abort rather than reporting a timeout', async () => {
    const outer = new AbortController();
    nextResponse = (init) => new Response(hangingStream(init?.signal ?? undefined), { status: 200 });
    const pending = boundedFetch('https://example.com/', {
      timeoutMs: 5_000,
      signal: outer.signal,
    });
    outer.abort();
    await expect(pending).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  test('passes caller headers through to the request', async () => {
    await boundedFetch('https://example.com/', { headers: { authorization: 'Bearer k' } });
    expect(fetchCalls[0].init?.headers).toMatchObject({ authorization: 'Bearer k' });
  });

  test('keeps redirect handling manual so the guard sees every hop', async () => {
    await boundedFetch('https://example.com/');
    expect(fetchCalls[0].init?.redirect).toBe('manual');
  });

  test('re-validates a redirect target and blocks an internal hop', async () => {
    let hop = 0;
    nextResponse = () => {
      hop += 1;
      return hop === 1
        ? new Response(null, { status: 302, headers: { location: 'https://evil.com/' } })
        : new Response('should never be reached', { status: 200 });
    };
    await expect(boundedFetch('https://example.com/')).rejects.toThrow();
    expect(fetchCalls).toHaveLength(1);
  });
});
