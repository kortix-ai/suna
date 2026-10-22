import { describe, expect, test } from 'bun:test';

import { signOutThisDevice } from './sign-out';

function fakeAuth(result: () => Promise<{ error: unknown }>) {
  const calls: unknown[] = [];
  return {
    calls,
    signOut(options: unknown) {
      calls.push(options);
      return result();
    },
  };
}

describe('signOutThisDevice', () => {
  test('ends only this device login (scope local), once', async () => {
    const auth = fakeAuth(async () => ({ error: null }));
    expect(await signOutThisDevice(auth)).toBeNull();
    expect(auth.calls).toEqual([{ scope: 'local' }]);
  });

  test('an error result is returned, not thrown', async () => {
    const error = new Error('logout failed');
    const auth = fakeAuth(async () => ({ error }));
    expect(await signOutThisDevice(auth)).toBe(error);
    expect(auth.calls).toEqual([{ scope: 'local' }]);
  });

  test('a rejected call is returned, not thrown', async () => {
    const error = new TypeError('Network request failed');
    const auth = fakeAuth(() => Promise.reject(error));
    expect(await signOutThisDevice(auth)).toBe(error);
  });
});
