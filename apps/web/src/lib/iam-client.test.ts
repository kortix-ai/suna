import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Pins the IAM client's error-surfacing contract: READS pass
 * `showErrors: false` (a capability-denied background query must never raise
 * the global "contact support" toast — the UI gates/hides instead), while
 * MUTATIONS keep default error surfacing (user-initiated; their call sites
 * toast specific messages).
 */

const calls: { method: string; path: string; options?: Record<string, unknown> }[] = [];

const ok = (data: unknown) => Promise.resolve({ success: true, data });

mock.module('@/lib/api-client', () => ({
  backendApi: {
    get: (path: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'get', path, options });
      return ok({ groups: [], policies: [], roles: [], agents: [] });
    },
    post: (path: string, _body?: unknown, options?: Record<string, unknown>) => {
      calls.push({ method: 'post', path, options });
      return ok({ group: { group_id: 'g1', name: 'x' } });
    },
    put: (path: string, _body?: unknown, options?: Record<string, unknown>) => {
      calls.push({ method: 'put', path, options });
      return ok({ ok: true });
    },
    delete: (path: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'delete', path, options });
      return ok({ ok: true });
    },
  },
}));

const { listGroups, listPolicies, listRoles, listAgentIdentities } = await import('./iam-client');

describe('iam-client error-surfacing contract', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test('reads are silent: list calls pass showErrors:false so a capability 403 never global-toasts', async () => {
    await listGroups('acc-1');
    await listPolicies('acc-1', { scopeId: 'proj-1' });
    await listRoles('acc-1');
    await listAgentIdentities('acc-1');

    const gets = calls.filter((c) => c.method === 'get');
    expect(gets.length).toBe(4);
    for (const c of gets) {
      expect(c.options?.showErrors).toBe(false);
    }
  });
});
