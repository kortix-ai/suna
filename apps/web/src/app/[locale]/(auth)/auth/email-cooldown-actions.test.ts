import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/en.json';

// One auth email per address per minute: inside the API's cooldown
// (`email_retry_after_seconds` on check-email) neither send action asks GoTrue
// for another email, and both answer "already sent" with the seconds left.

const translator = createTranslator({ locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete' });
let check: Record<string, unknown> = { mode: 'signin' };
let signInError: { code?: string; message: string; status?: number } | null = null;
const signUp = mock(async (_input: unknown) => ({ data: { user: null, session: null }, error: null }));
const signInWithOtp = mock(async (_input: unknown) => ({ error: null }));
const signInWithPassword = mock(async (_input: unknown) => ({
  data: signInError ? { user: null, session: null } : { user: { id: 'u1' }, session: { access_token: 'at', refresh_token: 'rt' } },
  error: signInError,
}));

mock.module('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://localhost:8008/v1' }),
}));
mock.module('@/lib/auth/sign-out-actions', () => ({ clearAuthBounceCookie: async () => {} }));
mock.module('@kortix/sdk', () => ({ checkAccessEmail: async () => check, submitAccessRequest: async () => ({}) }));
mock.module('@/i18n/get-translations', () => ({ getTranslations: async () => translator }));
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp, signInWithOtp, signInWithPassword } }),
}));

const { sendEmailCode, signUpWithPassword } = await import('./actions');

function form() {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('origin', 'http://localhost:13000');
  return data;
}

const NOT_CONFIRMED = { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 };

beforeEach(() => {
  check = { mode: 'signin' };
  signInError = null;
  signUp.mockClear();
  signInWithOtp.mockClear();
  signInWithPassword.mockClear();
});

test('password signup inside the cooldown does not mail the address again', async () => {
  check = { allowed: true, mode: 'signin', email_retry_after_seconds: 42 };
  signInError = NOT_CONFIRMED;
  const result = await signUpWithPassword(null, form());
  expect(signUp).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: true,
    requiresEmailConfirmation: true,
    alreadySent: true,
    retryAfterSeconds: 42,
    message: translator.raw('authEmailAlreadySent'),
  });
});

test('password signup inside the cooldown still signs a confirmed account in', async () => {
  check = { allowed: true, mode: 'signin', email_retry_after_seconds: 42 };
  const result = await signUpWithPassword(null, form());
  expect(signUp).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, accessToken: 'at' });
});

test('password signup inside the cooldown with a wrong password reads as an existing account', async () => {
  check = { allowed: true, mode: 'signin', email_retry_after_seconds: 42 };
  signInError = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 };
  expect(await signUpWithPassword(null, form())).toMatchObject({ code: 'existing_account_wrong_password' });
});

test('a first password signup sends once and starts the full countdown', async () => {
  check = { allowed: true, mode: 'signup' };
  signInError = NOT_CONFIRMED;
  const result = await signUpWithPassword(null, form());
  expect(signUp).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ requiresEmailConfirmation: true, alreadySent: false, retryAfterSeconds: 60 });
});

test('email link inside the cooldown answers the link step without a GoTrue send', async () => {
  check = { allowed: true, mode: 'signin', email_retry_after_seconds: 17 };
  const result = await sendEmailCode(null, form());
  expect(signInWithOtp).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, alreadySent: true, retryAfterSeconds: 17, email: 'synthetic@example.test' });
});

test('email link outside the cooldown sends once', async () => {
  const result = await sendEmailCode(null, form());
  expect(signInWithOtp).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ success: true, retryAfterSeconds: 60 });
  expect(result).not.toHaveProperty('alreadySent');
});
