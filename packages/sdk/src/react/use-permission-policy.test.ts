import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../core/http/config';

// Unlike the identity-config react-query mocks elsewhere in this package
// (`use-project-secrets.test.ts`, `use-gateway-routing-policy.test.ts`),
// `usePermissionPolicy` reads/writes the query cache directly (optimistic
// merge + rollback), so the mock backs a tiny in-memory store keyed by
// `JSON.stringify(queryKey)` — real enough to exercise cache read → optimistic
// write → server-reconcile → rollback, without a real QueryClient. The
// config object itself is still spread through (`enabled`, `queryKey`, …) so
// wiring assertions work exactly like the identity-mock hooks.
let store = new Map<string, unknown>();
let invalidated: unknown[][] = [];
let setDataCalls: Array<{ key: unknown[]; value: unknown }> = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => {
    const key = JSON.stringify(config.queryKey);
    return {
      ...config,
      data: store.get(key),
      isLoading: !store.has(key),
    };
  },
  useQueryClient: () => ({
    setQueryData: (key: unknown[], value: unknown) => {
      const k = JSON.stringify(key);
      const resolved = typeof value === 'function' ? (value as (old: unknown) => unknown)(store.get(k)) : value;
      store.set(k, resolved);
      setDataCalls.push({ key: [...key], value: resolved });
    },
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push([...opts.queryKey]);
    },
  }),
}));

const { permissionPolicyKey, usePermissionPolicy } = await import('./use-permission-policy');

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  store = new Map();
  invalidated = [];
  setDataCalls = [];
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = (async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    if (nextResponse.status >= 400) {
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

describe('usePermissionPolicy — query wiring', () => {
  test('uses the stable project-scoped query key', () => {
    const result = usePermissionPolicy('P1') as any;
    expect(result.queryKey).toEqual(permissionPolicyKey('P1'));
    expect(result.queryKey).toEqual(['project', 'P1', 'acp-permission-policy']);
  });

  test('is disabled without a projectId, enabled once one is supplied', () => {
    expect((usePermissionPolicy(undefined) as any).enabled).toBe(false);
    expect((usePermissionPolicy(null) as any).enabled).toBe(false);
    expect((usePermissionPolicy('P1') as any).enabled).toBe(true);
  });

  test('defaults to {autoApprove: "none", toolDecisions: {}} while loading (no cache entry yet)', () => {
    const result = usePermissionPolicy('P1');
    expect(result.isLoading).toBe(true);
    expect(result.policy).toEqual({ autoApprove: 'none', toolDecisions: {} });
  });

  test('reflects the cached policy once loaded', () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'reads', toolDecisions: { Bash: 'allow' } });
    const result = usePermissionPolicy('P1');
    expect(result.isLoading).toBe(false);
    expect(result.policy).toEqual({ autoApprove: 'reads', toolDecisions: { Bash: 'allow' } });
  });

  test('a different projectId gets its own (non-colliding) query key', () => {
    const a = usePermissionPolicy('proj-a') as any;
    const b = usePermissionPolicy('proj-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });
});

describe('usePermissionPolicy — setAutoApprove', () => {
  test('optimistically merges the new mode into the cache before the PUT resolves, then reconciles with the server response', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: { Bash: 'allow' } });
    nextResponse = { status: 200, body: { autoApprove: 'all', toolDecisions: { Bash: 'allow' } } };

    const result = usePermissionPolicy('P1');
    await result.setAutoApprove('all');

    // First write is the optimistic merge, second is the server reconcile.
    expect(setDataCalls.length).toBe(2);
    expect(setDataCalls[0]!.value).toEqual({ autoApprove: 'all', toolDecisions: { Bash: 'allow' } });
    expect(setDataCalls[1]!.value).toEqual({ autoApprove: 'all', toolDecisions: { Bash: 'allow' } });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/projects/P1/acp/permission-policy');
    expect(calls[0]!.body).toEqual({ autoApprove: 'all', toolDecisions: { Bash: 'allow' } });
  });

  test('rolls back by refetching the server state and rethrows the error on PUT failure', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: {} });
    nextResponse = { status: 500, body: { message: 'boom' } };

    const result = usePermissionPolicy('P1');

    // The optimistic value is visible immediately (cache already merged)...
    const pending = result.setAutoApprove('all');
    expect(setDataCalls[0]!.value).toEqual({ autoApprove: 'all', toolDecisions: {} });

    // ...but the write rejects, and the caller is told to refetch (rollback),
    // not left holding a hand-restored previous snapshot.
    await expect(pending).rejects.toBeTruthy();
    expect(invalidated).toEqual([permissionPolicyKey('P1') as unknown as unknown[]]);
  });
});

describe('usePermissionPolicy — rememberToolDecision', () => {
  test('optimistically merges a new tool decision, then reconciles with the server response', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: {} });
    nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: { Read: 'allow' } } };

    const result = usePermissionPolicy('P1');
    await result.rememberToolDecision('Read', 'allow');

    expect(setDataCalls[0]!.value).toEqual({ autoApprove: 'none', toolDecisions: { Read: 'allow' } });
    expect(calls[0]!.body).toEqual({ autoApprove: 'none', toolDecisions: { Read: 'allow' } });
  });

  test('updating an already-remembered tool overwrites in place (does not grow the count)', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: { Read: 'allow' } });
    nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: { Read: 'deny' } } };

    const result = usePermissionPolicy('P1');
    await result.rememberToolDecision('Read', 'deny');

    expect(setDataCalls[0]!.value).toEqual({ autoApprove: 'none', toolDecisions: { Read: 'deny' } });
  });

  test('rejects locally (no PUT, no cache mutation) when the tool name exceeds the 256-char key cap', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: {} });
    const result = usePermissionPolicy('P1');
    const longName = 'x'.repeat(257);

    await expect(result.rememberToolDecision(longName, 'allow')).rejects.toThrow(/256/);
    expect(calls.length).toBe(0);
    expect(setDataCalls.length).toBe(0);
  });

  test('accepts a tool name at exactly the 256-char cap', async () => {
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: {} });
    nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: {} } };
    const result = usePermissionPolicy('P1');
    const maxName = 'x'.repeat(256);

    await expect(result.rememberToolDecision(maxName, 'allow')).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
  });

  test('rejects locally (no PUT, no cache mutation) when a NEW tool would exceed the 128-tool cap', async () => {
    const full: Record<string, 'allow' | 'deny'> = {};
    for (let i = 0; i < 128; i++) full[`tool-${i}`] = 'allow';
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: full });

    const result = usePermissionPolicy('P1');
    await expect(result.rememberToolDecision('tool-129', 'allow')).rejects.toThrow(/128/);
    expect(calls.length).toBe(0);
    expect(setDataCalls.length).toBe(0);
  });

  test('updating an existing tool is allowed even when already at the 128-tool cap', async () => {
    const full: Record<string, 'allow' | 'deny'> = {};
    for (let i = 0; i < 128; i++) full[`tool-${i}`] = 'allow';
    store.set(JSON.stringify(permissionPolicyKey('P1')), { autoApprove: 'none', toolDecisions: full });
    nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: { ...full, 'tool-0': 'deny' } } };

    const result = usePermissionPolicy('P1');
    await expect(result.rememberToolDecision('tool-0', 'deny')).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
  });
});
