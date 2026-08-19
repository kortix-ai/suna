import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { NetworkBoundarySecretBinding } from './network-boundary';
import * as realPlatinum from '../shared/platinum';

type ExternalSecret = {
  id: string;
  name: string;
  description: string | null;
  current_gen: number;
  allow: string[];
  headers: string[];
  on_echo: 'block' | 'redact';
  value: string;
};

const external = new Map<string, ExternalSecret>();
const attached = new Map<string, string[]>();
const calls: Array<{ path: string; method: string; body: unknown }> = [];
let nextId = 1;
let attachmentState: 'armed' | 'arming' | 'unavailable' = 'armed';

mock.module('../shared/platinum', () => ({
  ...realPlatinum,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });

    // The real API resolves this path by ID ONLY — a name 404s here and then
    // POST answers 409 name_conflict. Verified against api.platinum.dev; the
    // mock used to accept either, which hid the bug that broke every re-arm.
    if (method === 'GET' && /^\/v1\/secrets\/[^?]+$/.test(path)) {
      const key = decodeURIComponent(path.slice('/v1/secrets/'.length));
      const item = [...external.values()].find((secret) => secret.id === key);
      if (!item) throw new Error(`platinum GET ${path} -> 404 {"code":"not_found"}`);
      const { value: _value, ...descriptor } = item;
      return descriptor;
    }
    // Cursor-paged list — the only way to resolve a replica by name.
    if (method === 'GET' && path.startsWith('/v1/secrets?')) {
      const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const limit = Number(params.get('limit') ?? '100');
      const cursor = params.get('cursor');
      const ordered = [...external.values()].map(({ value: _value, ...rest }) => rest);
      const start = cursor ? ordered.findIndex((item) => item.id === cursor) + 1 : 0;
      const items = ordered.slice(start, start + limit);
      const last = items.at(-1);
      const more = last ? ordered.indexOf(ordered.find((i) => i.id === last.id)!) + 1 < ordered.length : false;
      return { items, total: ordered.length, cursor: more && last ? last.id : null };
    }
    if (method === 'POST' && path === '/v1/secrets') {
      const id = `sec_${nextId++}`;
      const item: ExternalSecret = {
        id,
        name: body.name,
        description: body.description ?? null,
        current_gen: 1,
        allow: body.allow,
        headers: body.headers,
        on_echo: body.on_echo,
        value: body.value,
      };
      external.set(id, item);
      const { value: _value, ...descriptor } = item;
      return descriptor;
    }
    const versionMatch = path.match(/^\/v1\/secrets\/(sec_\d+)\/versions$/);
    if (method === 'POST' && versionMatch) {
      const item = external.get(versionMatch[1])!;
      item.value = body.value;
      item.current_gen += 1;
      const { value: _value, ...descriptor } = item;
      return descriptor;
    }
    const secretMatch = path.match(/^\/v1\/secrets\/(sec_\d+)$/);
    if (method === 'PATCH' && secretMatch) {
      const item = external.get(secretMatch[1])!;
      Object.assign(item, body);
      const { value: _value, ...descriptor } = item;
      return descriptor;
    }
    if (method === 'DELETE' && secretMatch) {
      external.delete(secretMatch[1]);
      return { id: secretMatch[1], deleted: true, value_erased: true };
    }
    const sandboxMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/secrets$/);
    if (sandboxMatch && method === 'GET') {
      const ids = attached.get(sandboxMatch[1]) ?? [];
      // Reports the CURRENT attachment state, so a poll can observe an edge that
      // is still arming instead of always answering 'armed' on the first read.
      return {
        sandbox_id: sandboxMatch[1],
        epoch: 1,
        leased_epoch: attachmentState === 'armed' ? 1 : 0,
        state: attachmentState,
        implied_egress: { domains: [], rules: {}, proxy: true },
        secrets: ids.map((id) => ({ secret_id: id, state: attachmentState })),
      };
    }
    if (sandboxMatch && method === 'PUT') {
      const ids = body.secrets.map((entry: { secret: string }) => entry.secret);
      attached.set(sandboxMatch[1], ids);
      return {
        sandbox_id: sandboxMatch[1],
        epoch: 2,
        leased_epoch: attachmentState === 'armed' ? 2 : 1,
        state: attachmentState,
        implied_egress: { domains: [], rules: {}, proxy: true },
        secrets: ids.map((id: string) => ({ secret_id: id, state: attachmentState })),
      };
    }
    throw new Error(`unhandled ${method} ${path}`);
  },
}));

const { preparePlatinumNetworkBoundary, syncPlatinumNetworkBoundary } = await import('./platinum-network-boundary');
const context = { environment: 'test', rootSecret: 'network-boundary-test-root' };

function binding(value = 'Bearer first-value'): NetworkBoundarySecretBinding {
  return {
    secretId: 'primary',
    identifier: 'billing-api',
    alias: 'KORTIX_primary',
    hosts: ['api.example.com'],
    header: 'authorization',
    value,
    onEcho: 'block',
  };
}

beforeEach(() => {
  external.clear();
  attached.clear();
  calls.length = 0;
  nextId = 1;
  attachmentState = 'armed';
});

describe('syncPlatinumNetworkBoundary', () => {
  test('prepares create-time attachments without touching a sandbox', async () => {
    const result = await preparePlatinumNetworkBoundary('logical-sandbox-1', [binding()], context);

    expect(result).toEqual({
      secrets: [{ secret: 'sec_1', alias: 'KORTIX_primary', header: 'authorization' }],
    });
    expect(calls.some((call) => call.path.startsWith('/v1/sandboxes/'))).toBe(false);
  });

  test('reuses the create-time replica during later synchronization', async () => {
    const prepared = await preparePlatinumNetworkBoundary('logical-sandbox-1', [binding()], context);
    attached.set('provider-sandbox-1', [prepared.secrets[0].secret]);
    calls.length = 0;

    await syncPlatinumNetworkBoundary('provider-sandbox-1', [binding()], context, {
      replicaOwnerId: 'logical-sandbox-1',
    });

    expect(external.size).toBe(1);
    expect(calls.some((call) => call.path.endsWith('/versions'))).toBe(false);
    expect(attached.get('provider-sandbox-1')).toEqual(['sec_1']);
  });

  test('creates a write-only provider secret and attaches the exact session set', async () => {
    const result = await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);

    expect(result).toEqual({ state: 'armed', attached: 1 });
    expect([...external.values()]).toHaveLength(1);
    expect([...external.values()][0]).toMatchObject({
      allow: ['api.example.com'],
      headers: ['authorization'],
      on_echo: 'block',
      value: 'Bearer first-value',
    });
    expect(attached.get('sandbox-1')).toEqual(['sec_1']);
  });

  test('does not rotate an unchanged secret', async () => {
    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);
    calls.length = 0;

    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);

    expect(calls.some((call) => call.path.endsWith('/versions'))).toBe(false);
    expect(external.get('sec_1')?.current_gen).toBe(1);
  });

  test('rotates a changed value without returning it from Platinum', async () => {
    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);
    calls.length = 0;

    await syncPlatinumNetworkBoundary('sandbox-1', [binding('Bearer rotated-value')], context);

    expect(calls.filter((call) => call.path.endsWith('/versions'))).toHaveLength(1);
    expect(external.get('sec_1')).toMatchObject({
      current_gen: 2,
      value: 'Bearer rotated-value',
    });
  });

  test('revokes the binding before erasing a removed provider replica', async () => {
    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);
    calls.length = 0;

    await syncPlatinumNetworkBoundary('sandbox-1', [], context);

    expect(attached.get('sandbox-1')).toEqual([]);
    expect(external.size).toBe(0);
    const putIndex = calls.findIndex((call) => call.method === 'PUT');
    const deleteIndex = calls.findIndex((call) => call.method === 'DELETE');
    expect(putIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(putIndex);
  });

  test('does not wait for an empty attachment set to become armed', async () => {
    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);
    calls.length = 0;
    attachmentState = 'arming';

    await syncPlatinumNetworkBoundary('sandbox-1', [], context);

    expect(
      calls.filter((call) => call.method === 'GET' && call.path.endsWith('/secrets')),
    ).toHaveLength(1);
    expect(attached.get('sandbox-1')).toEqual([]);
  });

  test('gives up on a stuck arm at the wall-clock budget, without hammering the edge', async () => {
    // The old loop was 40 attempts x 250ms, so its real ceiling was 10s PLUS 40
    // sequential round-trips. A deadline with backoff bounds the elapsed time
    // and cuts the poll count.
    attachmentState = 'arming';

    const startedAt = Date.now();
    await expect(
      syncPlatinumNetworkBoundary('sandbox-1', [binding()], context, { armTimeoutMs: 400 }),
    ).rejects.toThrow('did not arm for sandbox-1 within 400ms');
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(
      calls.filter((call) => call.method === 'GET' && call.path.endsWith('/secrets')),
    ).not.toHaveLength(0);
    expect(
      calls.filter((call) => call.method === 'GET' && call.path.endsWith('/secrets')).length,
    ).toBeLessThanOrEqual(4);
  });

  test('returns as soon as the edge reports armed', async () => {
    const startedAt = Date.now();
    await syncPlatinumNetworkBoundary('sandbox-1', [binding()], context);
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  test('fails closed when the provider reports an unavailable binding', async () => {
    attachmentState = 'unavailable';

    await expect(syncPlatinumNetworkBoundary('sandbox-1', [binding()], context)).rejects.toThrow(
      'unavailable',
    );
  });
});
