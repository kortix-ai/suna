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

const { fetchRuntimeMessages } = await import('./session-runtime-transport');

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

describe('fetchRuntimeMessages', () => {
  test('reads one page from the daemon messages route and returns its messages', async () => {
    const page = [{ info: { id: 'msg_1', role: 'user' }, parts: [] }];
    respond = () => Response.json({ session_id: 'ses_root', messages: page, has_more: false });

    const result = await fetchRuntimeMessages({ externalId: 'ext-1' }, 'ses/root', { limit: 50 });

    expect(result).toEqual({ ok: true, messages: page });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://daemon.local/kortix/opencode/messages/ses%2Froot?limit=50');
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
