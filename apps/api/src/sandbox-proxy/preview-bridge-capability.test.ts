import { expect, test } from 'bun:test';
import { createPreviewBridgeCapabilityResolver } from './preview-bridge-capability';

const record = {
  sandboxId: 'runtime-1', externalId: 'external-1', provider: 'daytona', serviceKey: 'key-1',
} as any;

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
