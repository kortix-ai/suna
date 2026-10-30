import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/de.json';

type AuthError = { code: string; message: string };
let error: AuthError;
let signupError: AuthError | null;

mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://127.0.0.1:1/v1' }),
}));
mock.module('@/i18n/get-translations', () => ({
  getTranslations: async () => createTranslator({
    locale: 'de', messages, namespace: 'hardcodedUi.i18nComplete',
  }),
}));
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: {
    signInWithOtp: async () => ({ error }),
    signInWithPassword: async () => ({ data: {}, error }),
    signUp: async () => ({ error: signupError }),
    resetPasswordForEmail: async () => ({ error }),
  } }),
}));

const { sendEmailCode, signInWithPassword, signUpWithPassword, forgotPassword } =
  await import('./actions');
const { POST: sendCodePost } = await import('../../../(system)/api/auth/send-code/route');
const { POST: forgotPasswordPost } = await import(
  '../../../(system)/api/auth/forgot-password/route'
);
const { NextRequest } = await import('next/server');

function form() {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('acceptedTerms', 'true');
  data.set('origin', 'http://localhost:13000');
  return data;
}

beforeEach(() => {
  error = { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' };
  signupError = null;
});

for (const action of [sendEmailCode, signInWithPassword, signUpWithPassword]) {
  test(`${action.name} returns localized email guidance, not raw rate-limit data`, async () => {
    const result = await action(null, form());
    expect(result.message).toBe(messages.hardcodedUi.i18nComplete.authEmailRateLimit);
    expect(result).not.toHaveProperty('code', error.code);
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
  test(`${action.name} returns localized request guidance without raw code`, async () => {
    error = { code: 'over_request_rate_limit', message: 'Over request rate limit' };
    const result = await action(null, form());
    expect(result.message).toBe(messages.hardcodedUi.i18nComplete.authRequestRateLimit);
    expect(result).not.toHaveProperty('code', error.code);
  });
}

for (const code of ['over_email_send_rate_limit', 'over_request_rate_limit', 'over_sms_send_rate_limit']) {
  test(`send-code returns 429 for ${code}, preserving localized guidance`, async () => {
    error = { code, message: 'Rate limit exceeded' };
    const response = await sendCodePost(new NextRequest('http://localhost:13000/api/auth/send-code', {
      method: 'POST', body: form(), headers: { origin: 'http://localhost:13000', host: 'localhost:13000' },
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(await response.json()).toMatchObject({
      message: code === 'over_email_send_rate_limit'
        ? messages.hardcodedUi.i18nComplete.authEmailRateLimit
        : messages.hardcodedUi.i18nComplete.authRequestRateLimit,
    });
  });
}

test('send-code returns 400 for an ordinary rejected send', async () => {
  error = { code: 'email_address_invalid', message: 'Invalid email address' };
  const response = await sendCodePost(new NextRequest('http://localhost:13000/api/auth/send-code', {
    method: 'POST', body: form(), headers: { origin: 'http://localhost:13000', host: 'localhost:13000' },
  }));
  expect(response.status).toBe(400);
  expect(response.headers.has('retry-after')).toBe(false);
  expect(await response.json()).toMatchObject({ message: error.message });
});

// The reset-link submit must answer a refused send the way send-code does:
// a 429 with the localized guidance, not a 200 body the browser cannot tell
// apart from success (KRTX-2049). Same codes, same Retry-After.
for (const code of ['over_email_send_rate_limit', 'over_request_rate_limit']) {
  test(`forgot-password returns 429 for ${code}, preserving localized guidance`, async () => {
    error = { code, message: 'Rate limit exceeded' };
    const response = await forgotPasswordPost(
      new NextRequest('http://localhost:13000/api/auth/forgot-password', {
        method: 'POST',
        body: form(),
        headers: { origin: 'http://localhost:13000', host: 'localhost:13000' },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(await response.json()).toMatchObject({
      message:
        code === 'over_email_send_rate_limit'
          ? messages.hardcodedUi.i18nComplete.authEmailRateLimit
          : messages.hardcodedUi.i18nComplete.authRequestRateLimit,
    });
  });
}

test('forgot-password returns 400 for an ordinary rejected send', async () => {
  error = { code: 'email_address_invalid', message: 'Invalid email address' };
  const response = await forgotPasswordPost(
    new NextRequest('http://localhost:13000/api/auth/forgot-password', {
      method: 'POST',
      body: form(),
      headers: { origin: 'http://localhost:13000', host: 'localhost:13000' },
    }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.has('retry-after')).toBe(false);
  expect(await response.json()).toMatchObject({ message: error.message });
});

test('email action preserves non-rate-limit messages', async () => {
  error = { code: 'email_address_invalid', message: 'Invalid email address' };
  expect(await sendEmailCode(null, form())).toEqual({ message: error.message, status: 400 });
});

test('password action preserves credential codes and messages', async () => {
  error = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  expect(await signInWithPassword(null, form())).toEqual({ message: error.message, code: error.code });
});

test('signup maps its own email quota error before attempting sign-in', async () => {
  signupError = error;
  error = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  expect(await signUpWithPassword(null, form())).toEqual({
    message: messages.hardcodedUi.i18nComplete.authEmailRateLimit,
  });
});
