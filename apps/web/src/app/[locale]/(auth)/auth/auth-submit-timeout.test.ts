// The server actions behind the auth submits must answer within a bound even
// when GoTrue hangs: the route handlers that carry the bounded client fetch
// wrap these actions, so an unbounded await here means the client's deadline
// never sees a proper JSON error. A never-settling Supabase call must surface
// as a typed failure result, not a hung POST.
import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/en.json';

let otpCall: () => Promise<unknown>;
let signInCall: () => Promise<unknown>;
let signUpCall: () => Promise<unknown>;

mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://127.0.0.1:1/v1' }),
}));
mock.module('@/i18n/get-translations', () => ({
  getTranslations: async () => createTranslator({
    locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete',
  }),
}));
// The flow-mode probe must fail open instantly (no real fetch — a pending
// socket would ride a timer the fake clock never advances). The other SDK
// exports exist because sibling auth modules import them.
mock.module('@kortix/sdk', () => ({
  checkAccessEmail: async () => {
    throw new Error('backend unreachable');
  },
  submitAccessRequest: async () => ({}),
  recordPlatformLogout: async () => ({}),
  updateUserMetadata: async () => ({}),
}));
// The flow-mode probe hits the dead BACKEND_URL and fails open to 'unknown'
// (the pattern bounce-attribution and rate-limit-actions use), so the test
// concentrates on the GoTrue await. No module other than these three is
// mocked: a mock left behind here would leak into sibling suites that import
// the real module, because bun keeps mock registrations for the process.
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: {
    signInWithOtp: otpCall,
    signInWithPassword: signInCall,
    signUp: signUpCall,
  } }),
}));

const { sendEmailCode, signInWithPassword } = await import('./actions');


const form = () => {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('acceptedTerms', 'true');
  data.set('origin', 'http://localhost:13000');
  return data;
};

beforeEach(() => {
  otpCall = () => new Promise(() => {});
  signInCall = () => new Promise(() => {});
  signUpCall = () => new Promise(() => {});
});
afterEach(() => {
  jest.useRealTimers();
});

/** Drain the action's pre-steps (incl. macrotasks: the dead-port probe's
 * rejection rides one) so it sits on its bounded await. */
const drain = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('sendEmailCode answers within the upstream bound when GoTrue hangs', async () => {
  jest.useFakeTimers();
  const pending = sendEmailCode(null, form()) as Promise<{ message?: string }>;
  await drain();
  jest.advanceTimersByTime(20_000);
  const result = await pending;
  expect(result?.message).toBeTruthy();
  expect(String(result.message).toLowerCase()).toContain('try again');
});

test('signInWithPassword answers within the upstream bound when GoTrue hangs', async () => {
  jest.useFakeTimers();
  const pending = signInWithPassword(null, form()) as Promise<{ message?: string }>;
  await drain();
  jest.advanceTimersByTime(20_000);
  const result = await pending;
  expect(result?.message).toBeTruthy();
  expect(String(result.message).toLowerCase()).toContain('try again');
});

test('a fast GoTrue answer still flows through unchanged', async () => {
  otpCall = async () => ({ data: {}, error: { code: 'user_not_found', message: 'User not found' } });
  const result = await sendEmailCode(null, form()) as { message?: string };
  expect(result?.message).toBe('User not found');
});
