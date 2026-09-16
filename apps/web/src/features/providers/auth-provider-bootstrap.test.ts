import { beforeEach, expect, mock, test } from 'bun:test';

const react = await import('react');
let effect: (() => (() => void) | undefined) | undefined;
let states: any[];
let stateIndex: number;
let validationError: Record<string, unknown> | null;
let signedOut: number;
let tokens: Array<string | null>;
const session = { user: { id: 'bootstrap-user' }, access_token: 'fixture-access-token' };

mock.module('react', () => ({
  ...react,
  useEffect: (callback: typeof effect) => {
    effect = callback;
  },
  useState: (initial: unknown) => {
    const index = stateIndex++;
    states[index] = initial;
    return [
      initial,
      (value: unknown) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
  useMemo: (callback: () => unknown) => callback(),
}));
mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session } }),
      getUser: async () => ({ data: { user: session.user }, error: validationError }),
      signOut: async () => {
        signedOut++;
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}));
mock.module('@/lib/auth-token', () => ({
  setBootstrapAuthToken: () => {},
  setCachedAuthToken: (token: string | null) => {
    tokens.push(token);
  },
}));
mock.module('@/lib/auth/identity-marker', () => ({
  IDENTITY_MARKER_KEY: 'fixture-identity',
  shouldResetClientState: () => false,
}));
mock.module('@/lib/auth/perform-sign-out', () => ({ performSignOut: async () => {} }));
mock.module('@/lib/utils/reset-client-state', () => ({ resetClientState: async () => {} }));
mock.module('@/lib/storage/managed-storage', () => ({
  safeGetItem: () => null,
  safeSetItem: () => {},
}));

const { AuthProvider } = await import('./auth-provider');

beforeEach(() => {
  effect = undefined;
  states = [];
  stateIndex = 0;
  validationError = null;
  signedOut = 0;
  tokens = [];
});

async function bootstrap(error: Record<string, unknown> | null) {
  validationError = error;
  AuthProvider({ children: null });
  const cleanup = effect?.();
  for (let i = 0; i < 20 && states[2] !== false; i++) await Promise.resolve();
  expect(states[2]).toBe(false);
  cleanup?.();
}

test.each([
  { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
  { name: 'AbortError', message: 'Navigation cancelled the request' },
  { name: 'AuthRetryableFetchError', status: 503, message: 'Service unavailable' },
  { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'Rate limited' },
])('bootstrap preserves the session after %j', async (error) => {
  await bootstrap(error);
  expect(signedOut).toBe(0);
  expect(states[0]).toBe(session);
  expect(states[1]).toBe(session.user);
  expect(tokens).toEqual([session.access_token]);
});

test.each([
  { status: 401, code: 'bad_jwt', message: 'Invalid JWT' },
  { status: 400, code: 'bad_jwt', message: 'Malformed JWT' },
  { status: 400, name: 'AuthSessionMissingError', message: 'Auth session missing' },
  { status: 403, code: 'session_not_found', message: 'Session not found' },
  { status: 403, code: 'user_not_found', message: 'User not found' },
])('bootstrap clears a confirmed invalid session: %j', async (error) => {
  await bootstrap(error);
  expect(signedOut).toBe(1);
  expect(states[0]).toBeNull();
  expect(states[1]).toBeNull();
  expect(tokens).toEqual([null]);
});

test('bootstrap publishes a validated session', async () => {
  await bootstrap(null);
  expect(signedOut).toBe(0);
  expect(states[0]).toBe(session);
  expect(states[1]).toBe(session.user);
  expect(tokens).toEqual([session.access_token]);
});
