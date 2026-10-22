import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: new URL('http://localhost/projects/synthetic-project?tab=audit&filter=rename'),
  },
});
let auth: { user: { id: string } | null; isLoading: boolean } = {
  user: { id: 'synthetic-user' },
  isLoading: false,
};
let signingOut = false;
const replace = mock();
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => auth }));
mock.module('@/lib/auth/sign-out-sequence', () => ({ isSigningOut: () => signingOut }));
mock.module('next/navigation', () => ({ useRouter: () => ({ replace }) }));
const { useSignedOutRedirect } = await import('./use-signed-out-redirect');

function Surface() {
  useSignedOutRedirect();
  return null;
}
let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  replace.mockClear();
  signingOut = false;
  auth = { user: { id: 'synthetic-user' }, isLoading: false };
});

describe('mounted session loss', () => {
  test('redirects to auth with the current path and query after the session disappears', () => {
    act(() => {
      tree = create(createElement(Surface));
    });
    expect(replace).not.toHaveBeenCalled();
    Object.assign(auth, { user: null });
    act(() => {
      tree?.update(createElement(Surface));
    });
    expect(replace).toHaveBeenCalledWith(
      '/auth?redirect=%2Fprojects%2Fsynthetic-project%3Ftab%3Daudit%26filter%3Drename',
    );
  });

  test('waits for auth loading and leaves explicit sign-out navigation alone', () => {
    Object.assign(auth, { user: null, isLoading: true });
    act(() => {
      tree = create(createElement(Surface));
    });
    expect(replace).not.toHaveBeenCalled();
    signingOut = true;
    auth.isLoading = false;
    act(() => {
      tree?.update(createElement(Surface));
    });
    expect(replace).not.toHaveBeenCalled();
  });
});
