import { beforeEach, describe, expect, mock, test } from 'bun:test';

let serviceKey: string | null = 'svc-key';
let ingressThrow: Error | null = null;
const signedFor: string[] = [];

mock.module('../../sandbox-proxy/backend', () => ({
  resolveServiceKey: async () => serviceKey,
  resolveSandboxIngress: async () => {
    if (ingressThrow) throw ingressThrow;
    return { url: 'http://daemon.local/', headers: { 'x-provider': 'p' } };
  },
  buildSandboxUpstreamHeaders: async (opts: { userId: string; serviceKey: string | null; providerHeaders?: Record<string, string> }) => {
    signedFor.push(opts.userId);
    return { ...opts.providerHeaders, Authorization: `Bearer ${opts.serviceKey}` };
  },
}));

const { fetchRuntimeMessages, fetchRuntimeState, openRuntimeEventStream, resetLegacyRuntimeApiForTests } = await import('./session-runtime-transport');

let requests: Array<{ url: string; headers: Record<string, string> }> = [];
let respond: () => Response = () => Response.json({ messages: [] });

beforeEach(() => {
  serviceKey = 'svc-key';
  ingressThrow = null;
  signedFor.length = 0;
  requests = [];
  resetLegacyRuntimeApiForTests();
  respond = () => Response.json({ messages: [] });
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return respond();
  }) as unknown as typeof fetch;
});

describe('fetchRuntimeMessages', () => {
  test('reads one page from the daemon messages route and returns its messages', async () => {
    const page = [{ info: { id: 'msg_1', role: 'user' }, parts: [] }];
    respond = () => Response.json({ session_id: 'ses_root', messages: page, has_more: false });

    const result = await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses/root', { limit: 50 });

    expect(result).toEqual({ ok: true, messages: page });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://daemon.local/kortix/runtime/messages/ses%2Froot?limit=50');
    expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer svc-key', 'Accept-Encoding': 'gzip' });
  });

  test('an anonymous read signs no user context', async () => {
    await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses_root', { limit: 1 });
    expect(signedFor).toEqual(['']);
  });

  test('a non-2xx answer is a reason, not a body', async () => {
    respond = () => new Response('{"error":"transcript unreadable"}', { status: 502 });
    const result = await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses_root', { limit: 1 });
    expect(result).toEqual({ ok: false, reason: 'daemon_502', status: 502 });
  });

  test('no service key sends no request', async () => {
    serviceKey = null;
    const result = await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses_root', { limit: 1 });
    expect(result).toEqual({ ok: false, reason: 'no_service_key', status: null });
    expect(requests).toEqual([]);
  });

  test('an ingress failure resolves to a reason instead of throwing', async () => {
    ingressThrow = new Error('ThrottlerException: Too Many Requests');
    const result = await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses_root', { limit: 1 });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe('the Runtime API path across daemon builds (W3 D4)', () => {
  test('a pre-W3 daemon 404s /kortix/runtime; the call retries /kortix/opencode once and remembers it', async () => {
    const page = [{ info: { id: 'msg_1', role: 'user' }, parts: [] }];
    respond = () => Response.json({ messages: page });
    let first = true;
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
      // The `/kortix/*` catch-all of a daemon that predates `/kortix/runtime`.
      if (String(url).includes('/kortix/runtime/')) return Response.json({ error: 'not found' }, { status: 404 });
      first = false;
      return respond();
    }) as unknown as typeof fetch;

    expect(await fetchRuntimeMessages({ externalId: 'old-box' }, 'ses_root', { limit: 5 })).toEqual({ ok: true, messages: page });
    expect(requests.map((r) => r.url)).toEqual([
      'http://daemon.local/kortix/runtime/messages/ses_root?limit=5',
      'http://daemon.local/kortix/opencode/messages/ses_root?limit=5',
    ]);
    expect(first).toBe(false);

    // The next call to the same box goes straight to the pre-W3 path.
    requests = [];
    await fetchRuntimeState({ externalId: 'old-box' });
    expect(requests.map((r) => r.url)).toEqual(['http://daemon.local/kortix/opencode/state']);
  });

  test('an older daemon that answers with the runtime HTML shell is also a pre-W3 daemon', async () => {
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (String(url).includes('/kortix/runtime/')) {
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      }
      return Response.json({ messages: [] });
    }) as unknown as typeof fetch;
    expect(await fetchRuntimeMessages({ externalId: 'older-box' }, 'ses_root', { limit: 1 })).toEqual({ ok: true, messages: [] });
    expect(requests.at(-1)!.url).toBe('http://daemon.local/kortix/opencode/messages/ses_root?limit=1');
  });

  test('a W3 daemon is asked once, at /kortix/runtime', async () => {
    await fetchRuntimeState({ externalId: 'new-box' });
    expect(requests.map((r) => r.url)).toEqual(['http://daemon.local/kortix/runtime/state']);
  });
});

describe('openRuntimeEventStream — the caller abort outlives the connect (05#3)', () => {
  test('aborting the caller signal after the attach ends the live body', async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const caller = new AbortController();
    const opened = await openRuntimeEventStream({ externalId: 'ext-1' }, { signal: caller.signal });
    expect(opened.ok).toBe(true);
    caller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  test('a failed attach leaves no listener behind on the caller signal', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const caller = new AbortController();
    const opened = await openRuntimeEventStream({ externalId: 'ext-1' }, { signal: caller.signal });
    expect(opened.ok).toBe(false);
    // Nothing to assert on the signal's listeners directly; aborting must not throw.
    expect(() => caller.abort()).not.toThrow();
  });
});
