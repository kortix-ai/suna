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
  } }),
}));

const { sendEmailCode, signInWithPassword, signUpWithPassword } = await import('./actions');

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

test('email action preserves non-rate-limit messages', async () => {
  error = { code: 'email_address_invalid', message: 'Invalid email address' };
  expect(await sendEmailCode(null, form())).toEqual({ message: error.message });
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
