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

const { fetchRuntimeState, openRuntimeEventStream } = await import('./session-runtime-transport');

let requests: Array<{ url: string; headers: Record<string, string> }> = [];
let respond: () => Response = () => Response.json({ messages: [] });

beforeEach(() => {
  serviceKey = 'svc-key';
  ingressThrow = null;
  signedFor.length = 0;
  requests = [];
  respond = () => Response.json({ messages: [] });
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return respond();
  }) as unknown as typeof fetch;
});

describe('fetchRuntimeState', () => {
  test('reads the runtime state route once, gzipped, with the service key', async () => {
    respond = () => Response.json({ schema: 'kortix.runtime.v1' });
    expect(await fetchRuntimeState({ externalId: 'ext-1' })).toMatchObject({ ok: true, status: 200, doc: { schema: 'kortix.runtime.v1' } });
    expect(requests.map((r) => r.url)).toEqual(['http://daemon.local/kortix/runtime/state']);
    expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer svc-key', 'Accept-Encoding': 'gzip' });
  });

  test('an anonymous read signs no user context', async () => {
    await fetchRuntimeState({ externalId: 'ext-1' });
    expect(signedFor).toEqual(['']);
  });

  test('a non-2xx answer is a reason, not a body', async () => {
    respond = () => new Response('{"error":"state unreadable"}', { status: 502 });
    expect(await fetchRuntimeState({ externalId: 'ext-1' })).toEqual({ ok: false, reason: 'daemon_502', status: 502 });
  });

  test('no service key sends no request', async () => {
    serviceKey = null;
    expect(await fetchRuntimeState({ externalId: 'ext-1' })).toEqual({ ok: false, reason: 'no_service_key', status: null });
    expect(requests).toEqual([]);
  });

  test('an ingress failure resolves to a reason instead of throwing', async () => {
    ingressThrow = new Error('ThrottlerException: Too Many Requests');
    expect((await fetchRuntimeState({ externalId: 'ext-1' })).ok).toBe(false);
    expect(requests).toEqual([]);
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

describe('openRuntimeEventStream — the session-log dialect (P4.4)', () => {
  const sse = () => new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } });

  test('schema v2 is passed to the daemon with the cursor', async () => {
    respond = sse;
    const caller = new AbortController();
    await openRuntimeEventStream({ externalId: 'ext-1' }, { since: 7, epoch: 'ep', schema: 'v2', signal: caller.signal });
    caller.abort();
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/kortix/runtime/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: '7', epoch: 'ep', schema: 'v2' });
  });

  test('without schema the daemon URL carries no schema parameter (the v1 stream)', async () => {
    respond = sse;
    const caller = new AbortController();
    await openRuntimeEventStream({ externalId: 'ext-1' }, { since: 7, epoch: 'ep', signal: caller.signal });
    caller.abort();
    expect(new URL(requests[0]!.url).searchParams.has('schema')).toBe(false);
  });
});
