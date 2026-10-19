import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';

// The shared "sign out, then land on /auth" dance (KRTX-2489's dedupe): a
// double tap does nothing, a failed sign-out leaves the screen usable (no
// route), a successful one routes and reports true. Real: the hook. The auth
// context and the router are stubs with recorded calls.

let signOutImpl: () => Promise<{ success: boolean } | null> = async () => ({ success: true });
const routeCalls: string[] = [];
let authProbe: { signingOut: boolean; run: () => Promise<boolean> } | null = null;

mock.module('expo-router', () => ({ useRouter: () => ({ replace: (href: string) => routeCalls.push(href) }) }));
mock.module('@/contexts', () => ({ useAuthContext: () => ({ signOut: (...args: unknown[]) => signOutImpl(...(args as [])) }) }));

// A probe surface: the boot screen's "disabled while signing out" button.
function Probe() {
  const { signingOut, signOutAndRoute } = require('@/hooks/useSignOutAndRoute').useSignOutAndRoute();
  authProbe = { signingOut, run: signOutAndRoute };
  return null;
}

let tree: any;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  authProbe = null;
  routeCalls.length = 0;
  signOutImpl = async () => ({ success: true });
});

function mount() {
  act(() => {
    tree = create(React.createElement(Probe));
  });
}

describe('useSignOutAndRoute', () => {
  test('a successful sign-out routes /auth and reports true', async () => {
    mount();
    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await authProbe!.run());
    });
    expect(outcomes[0]).toBe(true);
    expect(routeCalls).toEqual(['/auth']);
    expect(authProbe!.signingOut).toBe(false);
  });

  test('a failed sign-out (auth server down) routes nothing and reports false', async () => {
    signOutImpl = async () => null;
    mount();
    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await authProbe!.run());
    });
    expect(outcomes[0]).toBe(false);
    expect(routeCalls).toEqual([]);
  });

  test('a second tap while signing out does nothing', async () => {
    let release: ((value: { success: boolean }) => void) | null = null;
    signOutImpl = () => new Promise((resolve) => (release = resolve));
    mount();
    let first: Promise<boolean> | null = null;
    act(() => {
      first = authProbe!.run();
    });
    // Mid-sign-out: the probe re-renders with signingOut=true; the second run
    // must be the guard's no-op.
    let second: Promise<boolean> | null = null;
    act(() => {
      second = authProbe!.run();
    });
    await act(async () => {
      release!({ success: true });
      await first;
      await second;
    });
    expect(routeCalls).toEqual(['/auth']);
  });
});
