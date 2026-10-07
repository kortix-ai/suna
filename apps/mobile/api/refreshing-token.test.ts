import { expect, test } from 'bun:test';
import { createRefreshingToken } from './refreshing-token';

function source() {
  const calls = { read: 0, refresh: 0 };
  let n = 0;
  return {
    calls,
    auth: {
      read: async () => {
        calls.read++;
        return 'stored';
      },
      refresh: async () => {
        calls.refresh++;
        await new Promise((r) => setTimeout(r, 5));
        return `fresh${++n}`;
      },
    },
  };
}

test('reads the stored session until a 401 invalidates the token it handed out', async () => {
  const { auth, calls } = source();
  const getToken = createRefreshingToken(auth);
  expect(await getToken()).toBe('stored');
  getToken.invalidate('stored');
  expect(await getToken()).toBe('fresh1');
  expect(calls).toEqual({ read: 1, refresh: 1 });
});

test('parallel 401s on one token refresh once', async () => {
  const { auth, calls } = source();
  const getToken = createRefreshingToken(auth);
  await getToken();
  getToken.invalidate('stored');
  const first = getToken();
  getToken.invalidate('stored');
  const second = getToken();
  expect(await Promise.all([first, second])).toEqual(['fresh1', 'fresh1']);
  expect(calls.refresh).toBe(1);
});

test('a token the host never issued is ignored', async () => {
  const { auth, calls } = source();
  const getToken = createRefreshingToken(auth);
  await getToken();
  getToken.invalidate('someone-elses');
  expect(await getToken()).toBe('stored');
  expect(calls.refresh).toBe(0);
});

test('a failed refresh falls back to the stored session', async () => {
  const getToken = createRefreshingToken({ read: async () => 'stored', refresh: async () => null });
  await getToken();
  getToken.invalidate('stored');
  expect(await getToken()).toBe('stored');
});
