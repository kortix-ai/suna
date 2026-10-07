import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * A token refresh happens about once an hour and on many resumes. For the same
 * user it must not change the auth context value: every consumer (the sandbox
 * provider, the project screen, ~25 more) would render again. A real change of
 * user, of the user's data, or of the signed-in state must still reach them.
 */

// react-test-renderer ships no types.
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (element: React.ReactElement) => { unmount: () => void };
};

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

type Listener = (event: string, session: unknown) => Promise<void> | void;
let listener: Listener | null = null;
let restoredSession: unknown = null;

const noop = () => {};
const empty = () => ({});

mock.module('@/api/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: restoredSession } }),
      onAuthStateChange: (fn: Listener) => {
        listener = fn;
        return { data: { subscription: { unsubscribe: () => (listener = null) } } };
      },
    },
  },
}));
mock.module('react-native', () => ({
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: noop }) },
}));
mock.module('expo-web-browser', () => ({ maybeCompleteAuthSession: noop }));
mock.module('expo-apple-authentication', empty);
mock.module('expo-linking', empty);
mock.module('expo-auth-session/build/QueryParams', empty);
mock.module('@/lib/billing/provider', () => ({ shouldUseRevenueCat: () => false }));
mock.module('@/lib/auth/callback-state', () => ({
  consumeAuthCallbackState: async () => true,
  createAuthCallbackRedirect: async () => 'kortix://auth/callback',
}));
mock.module('@/lib/auth/mobile-admission', () => ({ admitMobileOAuthSession: async () => true }));
mock.module('@/lib/auth/session-expiry-monitor', () => ({ sessionExpiry: { disarm: noop } }));
mock.module('@/lib/utils/i18n', () => ({ applyProfileLocale: async () => {} }));
mock.module('@/lib/notifications/registration', () => ({ unregisterPushOnSignOut: async () => {} }));
mock.module('@/lib/query/query-cache', () => ({ queryCachePersistence: { release: async () => {} } }));
mock.module('@/lib/session/saved-copy-registry', () => ({ releaseSavedCopies: async () => {} }));
mock.module('@/lib/session/warm-session-pool', () => ({ warmSessionPool: { reset: noop } }));
// Sign-out resets these; this file never signs out through `signOut()`.
const store = { getState: () => ({ reset: noop, clear: noop }) };
for (const name of [
  'tab-store:useTabStore',
  'message-queue-store:useMessageQueueStore',
  'current-account-store:useCurrentAccountStore',
  'last-project-store:useLastProjectStore',
  'selected-project-store:useSelectedProjectStore',
  'tab-screenshot-store:useTabScreenshotStore',
  'composer-draft-store:useComposerDraftStore',
  'session-filter-store:useSessionFilterStore',
  'session-tree-store:useSessionTreeStore',
]) {
  const [file, hook] = name.split(':');
  mock.module(`@/stores/${file}`, () => ({ [hook]: store }));
}
mock.module('@/contexts/TrackingContext', () => ({
  useTracking: () => ({ canTrack: false, isLoading: false }),
}));

const { AuthProvider, useAuthContext } = await import('./AuthContext');

type Value = ReturnType<typeof useAuthContext>;
let seen: Value[] = [];
let tree: { unmount: () => void } | undefined;

function Probe() {
  seen.push(useAuthContext());
  return null;
}

function user(id: string, metadata: Record<string, unknown> = { full_name: 'Test User' }) {
  return { id, email: `${id}@example.test`, user_metadata: metadata, app_metadata: {}, aud: 'authenticated' };
}

function session(token: string, u: ReturnType<typeof user>) {
  return { access_token: token, refresh_token: `refresh-${token}`, user: u };
}

async function emit(event: string, next: unknown) {
  await act(async () => {
    await listener?.(event, next);
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  seen = [];
  restoredSession = session('t0', user('user-a'));
  const client = new QueryClient();
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(seen.at(-1)?.user?.id).toBe('user-a');
  expect(seen.at(-1)?.isAuthenticated).toBe(true);
  expect(seen.at(-1)?.isLoading).toBe(false);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
});

test('a token refresh for the same user keeps the context value', async () => {
  const before = seen.at(-1);
  const renders = seen.length;
  // A refresh hands a new session and a new (equal) user object.
  await emit('TOKEN_REFRESHED', session('t1', user('user-a')));
  await emit('INITIAL_SESSION', session('t2', user('user-a')));
  expect(seen.length).toBe(renders);
  expect(seen.at(-1)).toBe(before!);
});

test('the context does not hold a token that a refresh would leave stale', () => {
  expect('session' in seen.at(-1)!).toBe(false);
});

test('another user reaches every consumer', async () => {
  await emit('SIGNED_IN', session('t1', user('user-b')));
  expect(seen.at(-1)?.user?.id).toBe('user-b');
  expect(seen.at(-1)?.isAuthenticated).toBe(true);
});

test('a change to the same user\'s data reaches every consumer', async () => {
  const before = seen.at(-1);
  await emit('USER_UPDATED', session('t1', user('user-a', { full_name: 'Renamed' })));
  expect(seen.at(-1)).not.toBe(before!);
  expect(seen.at(-1)?.user?.user_metadata).toEqual({ full_name: 'Renamed' });
});

test('sign-out reaches every consumer', async () => {
  await emit('SIGNED_OUT', null);
  expect(seen.at(-1)?.user).toBeNull();
  expect(seen.at(-1)?.isAuthenticated).toBe(false);
});

function token(aal: string) {
  return `e30.${Buffer.from(JSON.stringify({ sub: 'user-a', aal })).toString('base64url')}.sig`;
}

test('a TOTP verify releases the code screen for the same user', async () => {
  const withTotp = { ...user('user-a'), factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  // A first-factor sign-in of a user with a verified TOTP factor owes a code.
  await emit('SIGNED_IN', session(token('aal1'), withTotp));
  expect(seen.at(-1)?.mfaRequired).toBe(true);
  const owing = seen.at(-1);
  const renders = seen.length;
  await emit('TOKEN_REFRESHED', session(token('aal1'), { ...withTotp }));
  expect(seen.length).toBe(renders);
  expect(seen.at(-1)).toBe(owing!);
  // Same user, same data: only the token's aal changes.
  await emit('MFA_CHALLENGE_VERIFIED', session(token('aal2'), { ...withTotp }));
  expect(seen.at(-1)).not.toBe(owing!);
  expect(seen.at(-1)?.mfaRequired).toBe(false);
  expect(seen.at(-1)?.isAuthenticated).toBe(true);
});
