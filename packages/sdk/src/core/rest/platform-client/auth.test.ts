import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from '../../http/config';
import { HeadlessAuthError, exchangeCode, resetPassword, sendMagicLink, signInWithPassword, signInWithProvider, signOut, signUp, updatePassword, authUser, verifyOtp, refreshSession } from './auth';

let calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
let nextStatus = 200;
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextStatus = 200;
  nextBody = { ok: true };
  configureKortix({
    backendUrl: 'http://backend.local',
    getToken: async () => null,
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') });
      return Response.json(nextBody, { status: nextStatus });
    },
  });
});

test('every call targets /v1/auth/* on the configured backend with the documented body', async () => {
  await signUp({ email: 'a@b', password: 'secret123' });
  await signInWithPassword({ email: 'a@b', password: 'secret123' });
  await sendMagicLink({ email: 'a@b', redirect_to: 'https://app/cb' });
  await verifyOtp({ email: 'a@b', token: '123456', type: 'magiclink' });
  await signInWithProvider({ provider: 'google', redirect_to: 'https://app/cb' });
  await exchangeCode({ code: 'c', code_verifier: 'v' });
  await refreshSession({ refresh_token: 'rt' });
  await resetPassword({ email: 'a@b' });
  await updatePassword({ password: 'newpass123' }, 'at');
  await authUser('at');
  await signOut('at', { scope: 'local' });
  expect(calls.map((c) => [c.method, c.url.replace('http://backend.local', ''), c.auth])).toEqual([
    ['POST', '/v1/auth/signup', null],
    ['POST', '/v1/auth/sign-in/password', null],
    ['POST', '/v1/auth/sign-in/magic-link', null],
    ['POST', '/v1/auth/verify-otp', null],
    ['POST', '/v1/auth/sign-in/oauth', null],
    ['POST', '/v1/auth/oauth/exchange', null],
    ['POST', '/v1/auth/refresh', null],
    ['POST', '/v1/auth/password/reset', null],
    ['POST', '/v1/auth/password/update', 'Bearer at'],
    ['GET', '/v1/auth/user', 'Bearer at'],
    ['POST', '/v1/auth/sign-out', 'Bearer at'],
  ]);
  expect(calls[3].body).toEqual({ email: 'a@b', token: '123456', type: 'magiclink' });
  expect(calls[10].body).toEqual({ scope: 'local' });
});

test('an upstream error becomes an HeadlessAuthError carrying code, description and status', async () => {
  nextStatus = 400;
  nextBody = { error: 'invalid_grant', error_description: 'Invalid login credentials' };
  const err = await signInWithPassword({ email: 'a@b', password: 'x' }).catch((e) => e);
  expect(err).toBeInstanceOf(HeadlessAuthError);
  expect(err).toMatchObject({ code: 'invalid_grant', message: 'Invalid login credentials', status: 400 });
});

test('an explicit backendUrl overrides the platform config', async () => {
  await signUp({ email: 'a@b', password: 'secret123' }, { backendUrl: 'https://self.host/v1/' });
  expect(calls[0].url).toBe('https://self.host/v1/auth/signup');
});
