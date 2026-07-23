import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let sandboxIngress: { url: string; headers: Record<string, string>; effectivePort: number } = {
  url: 'https://box.example',
  headers: { 'e2b-traffic-access-token': 'traffic-token' },
  effectivePort: 8000,
};
let serviceKey: string | null = 'svc-key';
let previewLinkError: Error | null = null;

mock.module('../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => {
    if (previewLinkError) throw previewLinkError;
    return sandboxIngress;
  },
  resolveServiceKey: async () => serviceKey,
}));

const { classifySessionStatusBody, probeSandboxBusy } = await import('./sandbox-busy-probe');

const realFetch = globalThis.fetch;
let fetchResponse: (() => Response | Promise<Response>) | null = null;
let lastRequest: { url: string; headers: Record<string, string> } | null = null;

beforeEach(() => {
  sandboxIngress = {
    url: 'https://box.example',
    headers: { 'e2b-traffic-access-token': 'traffic-token' },
    effectivePort: 8000,
  };
  serviceKey = 'svc-key';
  previewLinkError = null;
  fetchResponse = null;
  lastRequest = null;
  globalThis.fetch = (async (url: any, init: any) => {
    lastRequest = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    if (!fetchResponse) throw new Error('no fetch stub');
    return fetchResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('classifySessionStatusBody', () => {
  test('an in-flight ACP request marks the box busy', () => {
    expect(classifySessionStatusBody({ acp_busy: true })).toBe('busy');
  });
  test('all idle → idle', () => {
    expect(classifySessionStatusBody({ acp_busy: false })).toBe('idle');
  });
  test('missing ACP state → unknown', () => {
    expect(classifySessionStatusBody({})).toBe('unknown');
  });
  test('non-object bodies → unknown', () => {
    expect(classifySessionStatusBody(null)).toBe('unknown');
    expect(classifySessionStatusBody('nope')).toBe('unknown');
    expect(classifySessionStatusBody([1, 2])).toBe('unknown');
  });
});

describe('probeSandboxBusy', () => {
  const row = { sandboxId: 'sb-1', externalId: 'ext-1' };

  test('busy body → busy, with service and provider ingress auth sent', async () => {
    fetchResponse = () => new Response(JSON.stringify({ acp_busy: true }), { status: 200 });
    expect(await probeSandboxBusy(row)).toBe('busy');
    expect(lastRequest?.url).toBe('https://box.example/kortix/health');
    expect(lastRequest?.headers['Authorization']).toBe('Bearer svc-key');
    expect(lastRequest?.headers['e2b-traffic-access-token']).toBe('traffic-token');
    expect(lastRequest?.headers['X-Kortix-User-Context']).toContain('.');
  });

  test('all-idle body → idle', async () => {
    fetchResponse = () => new Response(JSON.stringify({ acp_busy: false }), { status: 200 });
    expect(await probeSandboxBusy(row)).toBe('idle');
  });

  test('non-200 daemon response → unknown', async () => {
    fetchResponse = () => new Response('nope', { status: 404 });
    expect(await probeSandboxBusy(row)).toBe('unknown');
  });

  test('fetch failure → unknown', async () => {
    fetchResponse = () => {
      throw new Error('timeout');
    };
    expect(await probeSandboxBusy(row)).toBe('unknown');
  });

  test('missing service key → unknown without calling the box', async () => {
    serviceKey = null;
    expect(await probeSandboxBusy(row)).toBe('unknown');
    expect(lastRequest).toBeNull();
  });

  test('preview-link resolution failure → unknown', async () => {
    previewLinkError = new Error('no sandbox row');
    expect(await probeSandboxBusy(row)).toBe('unknown');
  });
});
