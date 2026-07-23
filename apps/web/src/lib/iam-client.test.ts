import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { backendApi } from '@/lib/api-client';
import { listAgentIdentities, listGroups, listPolicies, listRoles } from './iam-client';

/**
 * Pins the IAM client's error-surfacing contract: READS pass
 * `showErrors: false` (a capability-denied background query must never raise
 * the global "contact support" toast — the UI gates/hides instead), while
 * MUTATIONS keep default error surfacing (user-initiated; their call sites
 * toast specific messages).
 */

const calls: { method: string; path: string; options?: Record<string, unknown> }[] = [];

const ok = (data: unknown) => Promise.resolve({ success: true, data });
const originalBackendApi = {
  get: backendApi.get,
  post: backendApi.post,
  put: backendApi.put,
  delete: backendApi.delete,
};

describe('iam-client error-surfacing contract', () => {
  beforeEach(() => {
    calls.length = 0;
    backendApi.get = ((path: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'get', path, options });
      return ok({ groups: [], policies: [], roles: [], agents: [] });
    }) as typeof backendApi.get;
    backendApi.post = ((path: string, _body?: unknown, options?: Record<string, unknown>) => {
      calls.push({ method: 'post', path, options });
      return ok({ group: { group_id: 'g1', name: 'x' } });
    }) as typeof backendApi.post;
    backendApi.put = ((path: string, _body?: unknown, options?: Record<string, unknown>) => {
      calls.push({ method: 'put', path, options });
      return ok({ ok: true });
    }) as typeof backendApi.put;
    backendApi.delete = ((path: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'delete', path, options });
      return ok({ ok: true });
    }) as typeof backendApi.delete;
  });

  afterAll(() => {
    Object.assign(backendApi, originalBackendApi);
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
