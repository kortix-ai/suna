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

    if (method === 'GET' && path.startsWith('/v1/secrets/')) {
      const key = decodeURIComponent(path.slice('/v1/secrets/'.length));
      const item = [...external.values()].find((secret) => secret.id === key || secret.name === key);
      if (!item) throw new Error(`platinum GET ${path} -> 404 {"code":"not_found"}`);
      const { value: _value, ...descriptor } = item;
      return descriptor;
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
      return {
        sandbox_id: sandboxMatch[1],
        epoch: 1,
        leased_epoch: 1,
        state: 'armed',
        implied_egress: { domains: [], rules: {}, proxy: true },
        secrets: ids.map((id) => ({ secret_id: id, state: 'armed' })),
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

const { syncPlatinumNetworkBoundary } = await import('./platinum-network-boundary');
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

  test('fails closed when the provider reports an unavailable binding', async () => {
    attachmentState = 'unavailable';

    await expect(syncPlatinumNetworkBoundary('sandbox-1', [binding()], context)).rejects.toThrow(
      'unavailable',
    );
  });
});
