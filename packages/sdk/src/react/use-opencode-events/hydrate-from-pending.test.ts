import { beforeEach, expect, mock, test } from 'bun:test';
// A box that serves its log answers a connect with ONE read: `GET /kortix/runtime/pending`.
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const paths: string[] = [];
mock.module('../../core/session/server-store/active', () => ({ getActiveRuntimeUrl: () => RUNTIME }));
const realAuth = await import('../../core/http/auth');
mock.module('../../core/http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname.replace('/v1/p/sbx_1/8000', '');
    paths.push(path);
    if (path === '/kortix/health') return Response.json({ capabilities: ['runtime.actions.v1', 'runtime.log.v1'] });
    if (path === '/kortix/runtime/pending') {
      return Response.json({
        statuses: { ses_root: 'busy', ses_child: 'compacting', ses_idle: 'idle' },
        permissions: [{ id: 'perm_1', thread_id: 'ses_root', call_id: 'call_1', payload: { permission: 'bash', patterns: ['ls'], always: [], metadata: {} }, asked_at: '' }],
        questions: [],
      });
    }
    return Response.json({ error: `unexpected ${path}` }, { status: 404 });
  },
}));
const { __resetRuntimeActionsMemo } = await import('../../core/session/runtime-actions');
const { useSyncStore } = await import('../../browser/stores/sync-store');
const { useRuntimePendingStore } = await import('../../browser/stores/opencode-pending-store');
const { hydrateFromPending } = await import('./hydrate-core');

beforeEach(() => {
  paths.length = 0;
  __resetRuntimeActionsMemo();
  useSyncStore.getState().reset();
  useRuntimePendingStore.setState({ permissions: {}, questions: {} });
});

test('one pending read: busy and compacting threads fill their status, the complete set reconciles, and each record is asked', async () => {
  const snapshots: unknown[] = [];
  const dispatched: Array<{ type: string; properties: Record<string, unknown> }> = [];
  hydrateFromPending({
    applySyncEvent: (event) => useSyncStore.getState().applyEvent(event),
    reconcileMissingBusySessions: { current: (statuses) => void snapshots.push(statuses) },
    threads: () => ['ses_root', 'ses_child'],
    dispatch: (event) => void dispatched.push(event as never),
  });
  for (let i = 0; i < 10 && dispatched.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  // No status, permission, question, diagnostics or transcript route: the capability read and the pending read.
  expect(paths).toEqual(['/kortix/health', '/kortix/runtime/pending']);
  expect(useSyncStore.getState().sessionStatus.ses_root).toEqual({ type: 'busy' });
  expect(useSyncStore.getState().sessionStatus.ses_child).toEqual({ type: 'busy' });
  expect(useSyncStore.getState().sessionStatus.ses_idle).toBeUndefined();
  expect(snapshots).toEqual([{ ses_root: { type: 'busy' }, ses_child: { type: 'busy' } }]);
  expect(dispatched.map((e) => [e.type, e.properties.id])).toEqual([['permission.asked', 'perm_1']]);
});
