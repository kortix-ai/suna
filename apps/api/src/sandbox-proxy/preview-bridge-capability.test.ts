import { expect, test } from 'bun:test';
import { createPreviewBridgeCapabilityResolver } from './preview-bridge-capability';

const record = {
  sandboxId: 'runtime-1', externalId: 'external-1', provider: 'daytona', serviceKey: 'key-1',
} as any;

test('a cold provider lookup lasting over one second still discovers the bridge', async () => {
  const resolve = createPreviewBridgeCapabilityResolver({
    resolveIngress: async () => {
      await Bun.sleep(1_100);
      return { url: 'https://daemon.test', headers: {}, effectivePort: 8000 };
    },
    buildHeaders: async () => ({}),
    fetch: async () => Response.json({ capabilities: { localhost_preview_bridge: 1 } }),
  });
  expect(await resolve(record)).toBe(true);
});

test.each(['http-error', 'timeout', 'invalid-json'])('a transient %s does not switch a confirmed bridge back to legacy ingress', async (failure) => {
  let now = 0;
  let fail = false;
  const resolve = createPreviewBridgeCapabilityResolver({
    now: () => now,
    timeoutMs: 10,
    resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
    buildHeaders: async () => ({}),
    fetch: async () => {
      if (!fail) return Response.json({ capabilities: { localhost_preview_bridge: 1 } });
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'invalid-json') return new Response('{');
      return new Response('temporarily unavailable', { status: 502 });
    },
  });
  expect(await resolve(record)).toBe(true);
  now = 15_001;
  fail = true;
  expect(await resolve(record)).toBe(true);
});

test('an explicit healthy downgrade switches a confirmed bridge back to legacy ingress', async () => {
  let now = 0;
  const resolve = createPreviewBridgeCapabilityResolver({
    now: () => now,
    resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
    buildHeaders: async () => ({}),
    fetch: async () => Response.json(now === 0
      ? { capabilities: { localhost_preview_bridge: 1 } }
      : { daemon: 'ok' }),
  });
  expect(await resolve(record)).toBe(true);
  now = 15_001;
  expect(await resolve(record)).toBe(false);
});

test('keeps old daemons on direct app ingress and enables an explicit v1 bridge', async () => {
  let body: unknown = { daemon: 'ok' };
  const resolve = createPreviewBridgeCapabilityResolver({
    now: () => 0,
    resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
    buildHeaders: async () => ({ Authorization: 'Bearer key-1' }),
    fetch: async () => Response.json(body),
  });

  expect(await resolve(record)).toBe(false);
  body = { daemon: 'ok', capabilities: { localhost_preview_bridge: 1 } };
  expect(await resolve({ ...record, sandboxId: 'runtime-2' })).toBe(true);
});

test('expires negative results promptly and deduplicates concurrent probes', async () => {
  let now = 0;
  let calls = 0;
  let body: unknown = { daemon: 'ok' };
  const resolve = createPreviewBridgeCapabilityResolver({
    now: () => now,
    resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
    buildHeaders: async () => ({ Authorization: 'Bearer key-1' }),
    fetch: async () => { calls++; return Response.json(body); },
  });

  expect(await Promise.all([resolve(record), resolve(record)])).toEqual([false, false]);
  expect(calls).toBe(1);
  body = { capabilities: { localhost_preview_bridge: 1 } };
  now = 2_001;
  expect(await resolve(record)).toBe(true);
  expect(calls).toBe(2);
});

test('does not reuse a positive result after runtime replacement or service-key rotation', async () => {
  let calls = 0;
  const resolve = createPreviewBridgeCapabilityResolver({
    resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
    buildHeaders: async () => ({}),
    fetch: async () => { calls++; return Response.json({ capabilities: { localhost_preview_bridge: 1 } }); },
  });

  expect(await resolve(record)).toBe(true);
  expect(await resolve({ ...record, sandboxId: 'runtime-2' })).toBe(true);
  expect(await resolve({ ...record, serviceKey: 'key-2' })).toBe(true);
  expect(calls).toBe(3);
});

test('uses direct ingress when health is unavailable or malformed', async () => {
  for (const fetcher of [
    async () => { throw new Error('unavailable'); },
    async () => new Response('{', { status: 200 }),
    async () => Response.json({ capabilities: { localhost_preview_bridge: 2 } }),
  ]) {
    const resolve = createPreviewBridgeCapabilityResolver({
      resolveIngress: async () => ({ url: 'https://daemon.test', headers: {}, effectivePort: 8000 }),
      buildHeaders: async () => ({ Authorization: 'Bearer key-1' }),
      fetch: fetcher,
    });
    expect(await resolve(record)).toBe(false);
  }
});

test('bounds and deduplicates ingress resolution from resolver entry', async () => {
  let ingressCalls = 0;
  const resolve = createPreviewBridgeCapabilityResolver({
    timeoutMs: 10,
    resolveIngress: async () => {
      ingressCalls++;
      return await new Promise(() => {});
    },
    buildHeaders: async () => ({}),
    fetch: async () => Response.json({ capabilities: { localhost_preview_bridge: 1 } }),
  });

  const startedAt = Date.now();
  expect(await Promise.all([resolve(record), resolve(record)])).toEqual([false, false]);
  expect(Date.now() - startedAt).toBeLessThan(100);
  expect(ingressCalls).toBe(1);
});

test('ignores a positive probe result that completes after the deadline', async () => {
  let now = 0;
  let finishOldIngress!: (value: any) => void;
  let ingressCalls = 0;
  const oldIngress = new Promise<any>((resolve) => { finishOldIngress = resolve; });
  const resolve = createPreviewBridgeCapabilityResolver({
    now: () => now,
    timeoutMs: 10,
    resolveIngress: async () => {
      ingressCalls++;
      return ingressCalls === 1
        ? oldIngress
        : { url: 'https://new-daemon.test', headers: {}, effectivePort: 8000 };
    },
    buildHeaders: async () => ({}),
    fetch: async (input) => Response.json({
      capabilities: String(input).includes('old-daemon')
        ? { localhost_preview_bridge: 1 }
        : {},
    }),
  });

  expect(await resolve(record)).toBe(false);
  now = 2_001;
  expect(await resolve(record)).toBe(false);
  finishOldIngress({ url: 'https://old-daemon.test', headers: {}, effectivePort: 8000 });
  await Bun.sleep(0);
  expect(await resolve(record)).toBe(false);
  expect(ingressCalls).toBe(2);
});
