import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/en.json';

const translator = createTranslator({ locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete' });
let delivered = false;
let cookieFailure = false;
let translationFailureAfterDelivery = false;
let mode = 'signin';
let sendError: { code: string; message: string; status: number } | null = null;
const send = mock(async (_input: unknown) => {
  delivered = !sendError;
  return { error: sendError };
});
mock.module('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    if (delivered && cookieFailure) throw new Error('cookie store unavailable');
    return { get: (key: string) => key.endsWith('-code-verifier') ? { value: 'base64-synthetic' } : undefined };
  },
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://localhost:8008/v1' }),
}));
mock.module('@/lib/auth/sign-out-actions', () => ({ clearAuthBounceCookie: async () => {} }));
mock.module('@kortix/sdk', () => ({ checkAccessEmail: async () => ({ mode }), submitAccessRequest: async () => ({}) }));
mock.module('@/i18n/get-translations', () => ({ getTranslations: async () => ({
  raw: (key: Parameters<typeof translator.raw>[0]) => {
    if (delivered && translationFailureAfterDelivery) throw new Error('translation unavailable');
    return translator.raw(key);
  },
}) }));
mock.module('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { signInWithOtp: send } }) }));
const { sendEmailCode } = await import('./actions');
const form = () => {
  const data = new FormData();
  data.set('email', ' SYNTHETIC@example.test ');
  data.set('origin', 'http://localhost:13000');
  data.set('returnUrl', '/invites/synthetic');
  data.set('acceptedTerms', 'true');
  data.set('referralCode', ' synthetic ');
  return data;
};
beforeEach(() => {
  delivered = false; cookieFailure = false; translationFailureAfterDelivery = false;
  mode = 'signin'; sendError = null; send.mockClear();
});
test('delivered send stays successful if the verifier cookie store fails', async () => {
  cookieFailure = true;
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, email: 'synthetic@example.test', codeVerifier: null, redirectTo: '/invites/synthetic' });
  expect(send).toHaveBeenCalledTimes(1);
});
test('success copy is resolved before delivery, so translation cannot undo a send', async () => {
  translationFailureAfterDelivery = true;
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, message: translator.raw('textd7eb7cdcff7d') });
});
test('keeps the PKCE fallback and normalized referral, terms and invite destination', async () => {
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, codeVerifier: 'base64-synthetic' });
  expect(send).toHaveBeenCalledWith({ email: 'synthetic@example.test', options: {
    emailRedirectTo: 'http://localhost:13000/auth/callback?returnUrl=%2Finvites%2Fsynthetic&terms_accepted=true',
    shouldCreateUser: true, data: { referral_code: 'SYNTHETIC' },
  } });
});
for (const error of [
  { code: 'email_address_invalid', message: 'Invalid email address', status: 400 },
  { code: 'timeout', message: 'Delivery is unknown', status: 503 },
  { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded', status: 429 },
]) {
  test(`upstream ${error.code} never reports success`, async () => {
    sendError = error;
    const result = await sendEmailCode(null, form());
    expect(result).not.toHaveProperty('success', true);
    expect(result).toHaveProperty('status', error.status);
    expect(result.message).toBeTruthy();
  });
}
for (const blocked of ['closed', 'sso']) {
  test(`${blocked} blocks delivery`, async () => {
    mode = blocked;
    expect(await sendEmailCode(null, form())).not.toHaveProperty('success', true);
    expect(send).not.toHaveBeenCalled();
  });
}
test('a rejected transport does not fabricate delivery success', async () => {
  send.mockImplementationOnce(async () => { throw new Error('transport failed'); });
  await expect(sendEmailCode(null, form())).rejects.toThrow('transport failed');
});
