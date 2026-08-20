// The client-side authorization probe, now SDK-owned.
//
// Harness: `@tanstack/react-query`'s `useQuery` is replaced by a lookup into a
// test-controlled store keyed on the serialized queryKey, so the hooks can be
// called as plain functions — no render tree — while still exercising the exact
// key, `enabled` flag and probe input the real hook builds. Same shape as
// `./use-project-secrets.test.ts`, extended so `data`/`isLoading`/`isError` are
// controllable per key (these hooks DERIVE their verdict from the query state,
// which an identity mock cannot express).

import { beforeEach, describe, expect, mock, test } from 'bun:test';

type QueryState = { data?: unknown; isLoading?: boolean; isError?: boolean };

let store: Record<string, QueryState> = {};
let seen: { key: unknown[]; enabled: boolean; staleTime?: number; queryFn: () => unknown }[] = [];
let invalidated: { queryKey: unknown[] }[] = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: {
    queryKey: unknown[];
    enabled?: boolean;
    staleTime?: number;
    queryFn: () => unknown;
  }) => {
    seen.push({
      key: config.queryKey,
      enabled: config.enabled !== false,
      staleTime: config.staleTime,
      queryFn: config.queryFn,
    });
    const hit = store[JSON.stringify(config.queryKey)] ?? {};
    return {
      data: hit.data,
      isLoading: hit.isLoading ?? false,
      isError: hit.isError ?? false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts);
      return Promise.resolve();
    },
  }),
}));

const { useCan, useCans, usePermissionsFor, invalidatePermissionProbes, permissionProbeKey, permissionProbeBatchKey } =
  await import('./use-can');

const set = (key: readonly unknown[], state: QueryState) => {
  store[JSON.stringify(key)] = state;
};

beforeEach(() => {
  store = {};
  seen = [];
  invalidated = [];
});

const ME = 'user-1';

// ── account scope ───────────────────────────────────────────────────────────

describe('useCan — account scope', () => {
  test('keys the probe on account, user, action and (null) target', () => {
    useCan({ accountId: 'acc-1' }, 'member.update', { userId: ME });
    expect(seen.at(-1)!.key).toEqual(['iam-permission', 'acc-1', ME, 'member.update', null, null]);
    expect(seen.at(-1)!.key).toEqual([...permissionProbeKey('acc-1', ME, 'member.update')]);
  });

  test('reports the API verdict once the probe resolves', () => {
    set(permissionProbeKey('acc-1', ME, 'member.update'), {
      data: { allowed: true, reason: 'role' },
    });
    expect(useCan({ accountId: 'acc-1' }, 'member.update', { userId: ME })).toEqual({
      allowed: true,
      reason: 'role',
      isLoading: false,
      isError: false,
    });
  });

  test('fails closed while loading and on error', () => {
    set(permissionProbeKey('acc-1', ME, 'member.update'), { isLoading: true });
    expect(useCan({ accountId: 'acc-1' }, 'member.update', { userId: ME })).toMatchObject({
      allowed: false,
      isLoading: true,
    });
    set(permissionProbeKey('acc-1', ME, 'member.update'), { isError: true });
    expect(useCan({ accountId: 'acc-1' }, 'member.update', { userId: ME })).toMatchObject({
      allowed: false,
      isError: true,
    });
  });

  test('is disabled — not denied — until the accountId is known', () => {
    const result = useCan({ accountId: undefined }, 'member.update', { userId: ME });
    expect(seen.at(-1)!.enabled).toBe(false);
    expect(result).toMatchObject({ allowed: false, isLoading: true });
  });

  test('carries a resource-scoped target into the key and the probe input', () => {
    useCan({ accountId: 'acc-1', resource: { type: 'group', id: 'g-1' } }, 'group.update', {
      userId: ME,
    });
    expect(seen.at(-1)!.key).toEqual([
      'iam-permission',
      'acc-1',
      ME,
      'group.update',
      'group',
      'g-1',
    ]);
  });
});

// ── project scope ───────────────────────────────────────────────────────────

describe('useCan — project scope', () => {
  test('probes the exact leaf against the project, not a coarse role label', () => {
    useCan({ projectId: 'proj-1', accountId: 'acc-1' }, 'project.gitops.push', { userId: ME });
    expect(seen.at(-1)!.key).toEqual([
      'iam-permission',
      'acc-1',
      ME,
      'project.gitops.push',
      'project',
      'proj-1',
    ]);
  });

  test('reports loading — never denied — while the owning account is still resolving', () => {
    const result = useCan({ projectId: 'proj-1' }, 'project.write', { userId: ME });
    expect(result).toEqual({ allowed: false, reason: null, isLoading: true, isError: false });
  });

  test('skips the project lookup entirely when the caller already knows the account', () => {
    useCan({ projectId: 'proj-1', accountId: 'acc-1' }, 'project.write', { userId: ME });
    const projectLookup = seen.find((s) => JSON.stringify(s.key).includes('"project","proj-1"'));
    expect(projectLookup?.enabled).toBe(false);
  });
});

// ── batch ───────────────────────────────────────────────────────────────────

describe('useCans', () => {
  const ACTIONS = ['project.write', 'project.delete'] as const;

  test('asks once for every action and returns a map keyed by action', () => {
    set(permissionProbeBatchKey('acc-1', ME, [
      { action: 'project.write', resourceType: 'project', resourceId: 'proj-1' },
      { action: 'project.delete', resourceType: 'project', resourceId: 'proj-1' },
    ]), {
      data: [
        { allowed: true, reason: 'role' },
        { allowed: false, reason: 'role' },
      ],
    });
    const caps = useCans({ projectId: 'proj-1', accountId: 'acc-1' }, ACTIONS, { userId: ME });
    expect(Object.keys(caps)).toEqual(['project.write', 'project.delete']);
    expect(caps['project.write'].allowed).toBe(true);
    expect(caps['project.delete'].allowed).toBe(false);
  });

  test('every entry reports loading while the account is unresolved', () => {
    const caps = useCans({ projectId: 'proj-1' }, ACTIONS, { userId: ME });
    expect(caps['project.write']).toMatchObject({ allowed: false, isLoading: true });
    expect(caps['project.delete']).toMatchObject({ allowed: false, isLoading: true });
  });

  test('never fires an empty batch', () => {
    useCans({ accountId: 'acc-1' }, [], { userId: ME });
    expect(seen.at(-1)!.enabled).toBe(false);
  });
});

describe('usePermissionsFor', () => {
  test('answers for ANOTHER member, in input order', () => {
    const probes = [{ action: 'member.read' }, { action: 'role.create' }];
    set(permissionProbeBatchKey('acc-1', 'other-user', probes), {
      data: [
        { allowed: false, reason: 'role' },
        { allowed: true, reason: 'super_admin' },
      ],
    });
    const out = usePermissionsFor('acc-1', 'other-user', probes);
    expect(out.map((r) => r.allowed)).toEqual([false, true]);
    expect(out[1].reason).toBe('super_admin');
  });
});

// ── the cache contract ──────────────────────────────────────────────────────

describe('invalidatePermissionProbes', () => {
  const client = { invalidateQueries: (o: { queryKey: unknown[] }) => invalidated.push(o) } as any;

  test('busts BOTH the single and the batch probe caches for the account', async () => {
    await invalidatePermissionProbes(client, { accountId: 'acc-1' });
    expect(invalidated.map((i) => i.queryKey)).toEqual([
      ['iam-permission', 'acc-1'],
      ['iam-permission-batch', 'acc-1'],
    ]);
  });

  test('narrows to one principal when a userId is supplied', async () => {
    await invalidatePermissionProbes(client, { accountId: 'acc-1', userId: ME });
    expect(invalidated.map((i) => i.queryKey)).toEqual([
      ['iam-permission', 'acc-1', ME],
      ['iam-permission-batch', 'acc-1', ME],
    ]);
  });

  test('busts every account when none is named — a role change can move any verdict', async () => {
    await invalidatePermissionProbes(client, {});
    expect(invalidated.map((i) => i.queryKey)).toEqual([
      ['iam-permission'],
      ['iam-permission-batch'],
    ]);
  });
});
