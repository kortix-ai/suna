/**
 * SsoRequiredSignOut (KRTX-1716): a 403 `sso_required` signs the session out
 * once, however many calls were refused, and opens the SSO form with the
 * user's email only after the sign-out lands. A refusal while signed out
 * changes nothing.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useSsoRequiredStore } from '@/lib/auth/sso-required';

const replaced: unknown[] = [];
let signOuts = 0;
const auth = {
  user: { email: 'member@sso.example.test' } as { email?: string } | null,
  isAuthenticated: true,
  signOut: async () => {
    signOuts += 1;
    return { success: true };
  },
};

mock.module('expo-router', () => ({ useRouter: () => ({ replace: (href: unknown) => replaced.push(href) }) }));
mock.module('@/contexts', () => ({ useAuthContext: () => auth }));
mock.module('@/lib/logger', () => ({ log: { warn: () => {}, log: () => {}, error: () => {} } }));

let SsoRequiredSignOut: typeof import('./SsoRequiredSignOut').SsoRequiredSignOut;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SsoRequiredSignOut } = await import('./SsoRequiredSignOut'));
});

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  replaced.length = 0;
  signOuts = 0;
  auth.user = { email: 'member@sso.example.test' };
  auth.isAuthenticated = true;
  useSsoRequiredStore.setState({ reported: false });
});

function mount() {
  act(() => {
    renderer = create(<SsoRequiredSignOut />);
  });
}

/** The sign-out landed: the auth context reports a signed-out user. */
function signOutLands() {
  auth.user = null;
  auth.isAuthenticated = false;
  act(() => renderer!.update(<SsoRequiredSignOut />));
}

describe('SsoRequiredSignOut', () => {
  test('nothing happens until a call is refused', () => {
    mount();
    expect(signOuts).toBe(0);
    expect(replaced).toEqual([]);
  });

  test('a burst of refusals signs out once, then opens the SSO form with the email', () => {
    mount();
    act(() => useSsoRequiredStore.setState({ reported: true }));
    act(() => useSsoRequiredStore.setState({ reported: true }));
    act(() => useSsoRequiredStore.setState({ reported: true }));
    expect(signOuts).toBe(1);
    // Still signed in: the auth layout would bounce the SSO form back to `/`.
    expect(replaced).toEqual([]);

    signOutLands();
    expect(replaced).toEqual([
      { pathname: '/auth/email', params: { reason: 'sso_required', email: 'member@sso.example.test' } },
    ]);
    expect(useSsoRequiredStore.getState().reported).toBe(false);

    // A refusal still in flight after the sign-out changes nothing.
    act(() => useSsoRequiredStore.setState({ reported: true }));
    expect(signOuts).toBe(1);
    expect(replaced).toHaveLength(1);
    expect(useSsoRequiredStore.getState().reported).toBe(false);
  });

  test('a refusal while signed out is dropped', () => {
    auth.user = null;
    auth.isAuthenticated = false;
    mount();
    act(() => useSsoRequiredStore.setState({ reported: true }));
    expect(signOuts).toBe(0);
    expect(replaced).toEqual([]);
    expect(useSsoRequiredStore.getState().reported).toBe(false);
  });
});
