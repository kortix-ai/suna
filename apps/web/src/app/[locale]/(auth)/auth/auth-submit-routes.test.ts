// The POST handlers under /api/auth/* carry the auth page's bounded fetches.
// They must forward the form to the same actions the server actions use,
// return the action result as JSON, reject cross-origin POSTs (the CSRF
// protection server actions got for free), and answer within a bound even
// when an action itself hangs.
//
// The actions are exercised for real here — only their Supabase transport is
// mocked — so the route + action pair is tested as it ships.
import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const supabaseCalls: string[] = [];
let otpResult: () => Promise<unknown> = async () => ({ data: {}, error: null });
let signInResult: () => Promise<unknown> = async () => ({
  data: { user: { id: 'u1', created_at: new Date().toISOString() }, session: { access_token: 'a', refresh_token: 'r' } },
  error: null,
});
let signUpResult: () => Promise<unknown> = async () => ({ data: {}, error: null });

mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://127.0.0.1:1/v1' }),
}));
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: {
    signInWithOtp: async (args: unknown) => {
      supabaseCalls.push(`otp:${JSON.stringify(Object.keys(args ?? {}))}`);
      return otpResult();
    },
    signInWithPassword: async () => {
      supabaseCalls.push('signIn');
      return signInResult();
    },
    signUp: async () => {
      supabaseCalls.push('signUp');
      return signUpResult();
    },
  } }),
}));

const { POST: sendCodePost } = await import('../../../(system)/api/auth/send-code/route');
const { POST: passwordPost } = await import('../../../(system)/api/auth/password/route');
const { AUTH_ROUTE_TIMEOUT_MS } = await import('@/lib/auth/submit-auth');

const form = () => {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('acceptedTerms', 'true');
  data.set('origin', 'http://localhost:13000');
  return data;
};

const sendCodeRequest = (origin: string | null) =>
  new NextRequest('http://localhost:13000/api/auth/send-code', {
    method: 'POST',
    body: form(),
    headers: origin ? { origin, host: 'localhost:13000' } : {},
  });

const passwordRequest = (intent: string) =>
  new NextRequest(`http://localhost:13000/api/auth/password?intent=${intent}`, {
    method: 'POST',
    body: form(),
    headers: { origin: 'http://localhost:13000', host: 'localhost:13000' },
  });

beforeEach(() => {
  supabaseCalls.length = 0;
  otpResult = async () => ({ data: {}, error: null });
  signInResult = async () => ({
    data: { user: { id: 'u1', created_at: new Date().toISOString() }, session: { access_token: 'a', refresh_token: 'r' } },
    error: null,
  });
  signUpResult = async () => ({ data: {}, error: null });
});
afterEach(() => {
  jest.useRealTimers();
});

test('send-code forwards the form to the action and returns its result as JSON', async () => {
  const res = await sendCodePost(sendCodeRequest('http://localhost:13000'));
  expect(res.status).toBe(200);
  const body = await res.json() as { success?: boolean; email?: string };
  expect(body.success).toBe(true);
  expect(body.email).toBe('synthetic@example.test');
  expect(supabaseCalls.some((call) => call.startsWith('otp:'))).toBe(true);
});

test('sign-up intent routes to signUp (and its sign-in follow-up)', async () => {
  signUpResult = async () => ({ data: {}, error: null });
  const res = await passwordPost(passwordRequest('signup'));
  expect(res.status).toBe(200);
  expect(supabaseCalls).toContain('signUp');
  expect(supabaseCalls).toContain('signIn');
});

test('sign-in intent routes to signInWithPassword only', async () => {
  const res = await passwordPost(passwordRequest('signin'));
  expect(res.status).toBe(200);
  const body = await res.json() as { success?: boolean; redirectTo?: string };
  expect(body.success).toBe(true);
  expect(body.redirectTo).toBeTruthy();
  expect(supabaseCalls).toEqual(['signIn']);
});

test('a cross-origin POST is rejected without reaching the action', async () => {
  const res = await sendCodePost(sendCodeRequest('https://evil.example'));
  expect(res.status).toBe(403);
  expect(supabaseCalls).toHaveLength(0);
});

test('a POST with no origin header at all is rejected', async () => {
  const res = await sendCodePost(sendCodeRequest(null));
  expect(res.status).toBe(403);
  expect(supabaseCalls).toHaveLength(0);
});

test('an action that never settles still answers within the route bound', async () => {
  jest.useFakeTimers();
  otpResult = () => new Promise(() => {});
  const pending = sendCodePost(sendCodeRequest('http://localhost:13000'));
  // The handler parses the multipart body on the event loop before it starts
  // its bound — drain until the deadline timer exists, then advance past it.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  jest.advanceTimersByTime(AUTH_ROUTE_TIMEOUT_MS);
  const res = await pending;
  expect(res.status).toBe(200);
  const body = await res.json() as { message?: string };
  expect(body.message).toBeTruthy();
  expect(String(body.message).toLowerCase()).toContain('try again');
});

test('an action that throws answers 500 with a JSON error, never a hung response', async () => {
  // Deferred so the route attaches its catch before the rejection fires —
  // an immediately-rejected promise would be flagged unhandled and poison
  // sibling suites running in the same process.
  otpResult = () =>
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('boom')), 5);
    });
  const res = await sendCodePost(sendCodeRequest('http://localhost:13000'));
  expect(res.status).toBe(500);
  const body = await res.json() as { message?: string };
  expect(body.message).toBeTruthy();
});
