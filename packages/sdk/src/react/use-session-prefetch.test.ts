import { afterEach, expect, test } from 'bun:test';
import { configureKortix } from '../core/http/config';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { getSessionSyncController, resetSessionSyncControllers, retainSessionSyncController } from '../browser/session-sync/session-sync-registry';
import { prefetchSession } from './use-session-prefetch';

afterEach(() => {
  resetSessionSyncControllers();
  useSyncStore.getState().reset();
  setCurrentRuntime(null);
});

test('active prefetch and a retained consumer share the same explicit scope and URL', async () => {
  const reads: string[] = [];
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'test', fetch: async (input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    return Response.json([]);
  } });
  setCurrentRuntime('https://prefetch-a.test', 'a');
  useSandboxConnectionStore.setState({ healthy: true });
  await prefetchSession('ses-prefetch');
  const controller = getSessionSyncController('ses-prefetch', undefined, 'a');
  const release = retainSessionSyncController('ses-prefetch', 'a');
  setCurrentRuntime('https://prefetch-b.test', 'b');
  await controller.reconcile();
  release();
  expect(reads).toEqual([
    'https://prefetch-a.test/session/ses-prefetch/message?limit=50',
    'https://prefetch-a.test/session/ses-prefetch/message?limit=50',
  ]);
  expect(useSyncStore.getState().sessionRuntime['ses-prefetch']).toBe('a');
});
