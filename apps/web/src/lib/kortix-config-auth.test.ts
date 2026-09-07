import { afterEach, expect, mock, test } from 'bun:test';
import {
  __resetAuthTokenCacheForTests,
  __setFetchTokenForTests,
  setCachedAuthToken,
} from './auth-token';

const sdk = await import('@kortix/sdk');
let getToken: () => Promise<string | null>;
mock.module('@kortix/sdk', () => ({
  ...sdk,
  configureKortix: (config: { getToken: typeof getToken }) => {
    getToken = config.getToken;
  },
}));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => false }));
mock.module('@/lib/env-config', () => ({ getEnv: () => ({ BACKEND_URL: 'https://api.test/v1' }) }));
mock.module('@/lib/error-handler', () => ({ handleApiError: () => {} }));
mock.module('@/components/ui/toast', () => ({
  errorToast: () => {},
  infoToast: () => {},
  successToast: () => {},
  warningToast: () => {},
}));
mock.module('@/lib/web-notifications', () => ({
  notifyPermissionRequest: () => {},
  notifyQuestion: () => {},
  notifySessionError: () => {},
  notifyTaskComplete: () => {},
}));
await import('./kortix-config');
afterEach(() => {
  __resetAuthTokenCacheForTests();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('concurrent SDK reads receive the current bootstrap token after an in-flight token read is superseded', async () => {
  const pending = deferred<string | null>();
  let reads = 0;
  __setFetchTokenForTests(() => {
    reads++;
    return pending.promise;
  });
  const requests = [getToken(), getToken(), getToken()];
  setCachedAuthToken('current-bootstrap-token');
  pending.resolve('superseded-token');
  expect(await Promise.all(requests)).toEqual([
    'current-bootstrap-token',
    'current-bootstrap-token',
    'current-bootstrap-token',
  ]);
  expect(reads).toBe(1);
});

test('SDK token handoff rechecks the current identity after invalidation without returning stale credentials', async () => {
  const pending = deferred<string | null>();
  __setFetchTokenForTests(() => pending.promise);
  const request = getToken();
  setCachedAuthToken(null);
  __setFetchTokenForTests(async () => 'new-identity-token');
  pending.resolve('old-identity-token');
  expect(await request).toBe('new-identity-token');
});

test('a signed-out SDK caller receives no token after bounded retries', async () => {
  let reads = 0;
  __setFetchTokenForTests(async () => {
    reads++;
    return null;
  });
  expect(await getToken()).toBeNull();
  expect(reads).toBe(4);
});
