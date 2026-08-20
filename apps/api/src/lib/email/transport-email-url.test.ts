// EMAIL_URL is the single configuration surface: it selects the provider(s),
// the order they are tried in, and (with EMAIL_FROM) the sender identity —
// overriding every pre-EMAIL_URL variable.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  EMAIL_URL: '',
  EMAIL_FROM: '',
  EMAIL_PROVIDER_ORDER: 'ses,resend,mailtrap',
  AWS_SES_REGION: 'us-east-2',
  AWS_SES_ACCESS_KEY_ID: '',
  AWS_SES_SECRET_ACCESS_KEY: '',
  RESEND_API_KEY: '',
  RESEND_FROM_EMAIL: '',
  MAILPIT_API_URL: '',
  MAILTRAP_API_TOKEN: '',
  MAILTRAP_FROM_EMAIL: 'noreply@kortix.com',
  MAILTRAP_FROM_NAME: 'Kortix',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_USER: '',
  SMTP_PASS: '',
};

mock.module('../../config', () => ({ config: mockConfig }));

const { configuredEmailProviders, emailSender, isEmailConfigured, sendEmail } =
  await import('./transport');

let calls: Array<{ url: string; init: RequestInit }> = [];
let responder: (url: string) => Response;

beforeEach(() => {
  calls = [];
  responder = () => new Response('{}', { status: 200 });
  Object.assign(mockConfig, {
    EMAIL_URL: '',
    EMAIL_FROM: '',
    EMAIL_PROVIDER_ORDER: 'ses,resend,mailtrap',
    RESEND_API_KEY: '',
    RESEND_FROM_EMAIL: '',
    MAILTRAP_API_TOKEN: '',
    MAILPIT_API_URL: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
  });
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url));
  }) as unknown as typeof fetch;
});

const MSG = {
  to: ['user@example.test'],
  subject: 'Test',
  html: '<p>hello</p>',
  category: 'unit-test',
};

describe('EMAIL_URL configuration', () => {
  test('one URL configures the provider with no other variable set', () => {
    mockConfig.EMAIL_URL = 'resend://re_live_key';
    expect(isEmailConfigured()).toBe(true);
    expect(configuredEmailProviders()).toEqual(['resend']);
  });

  test('a comma-separated list becomes the fallback chain, in order', () => {
    mockConfig.EMAIL_URL = 'ses://us-east-2,resend://re_key,mailtrap://tok';
    expect(configuredEmailProviders()).toEqual(['ses', 'resend', 'mailtrap']);
  });

  test('EMAIL_URL overrides the pre-EMAIL_URL variables entirely', () => {
    mockConfig.RESEND_API_KEY = 're_legacy';
    mockConfig.MAILTRAP_API_TOKEN = 'tok_legacy';
    mockConfig.EMAIL_URL = 'mailpit://127.0.0.1:8025';
    expect(configuredEmailProviders()).toEqual(['mailpit']);
  });

  test('an unparsable EMAIL_URL disables delivery rather than sending anywhere else', () => {
    mockConfig.RESEND_API_KEY = 're_legacy';
    mockConfig.EMAIL_URL = 'not-a-url';
    expect(isEmailConfigured()).toBe(false);
  });

  test('EMAIL_FROM sets the sender; without it the legacy pair still applies', () => {
    mockConfig.EMAIL_FROM = 'Acme Support <no-reply@acme.test>';
    expect(emailSender()).toEqual({ email: 'no-reply@acme.test', name: 'Acme Support' });
    mockConfig.EMAIL_FROM = '';
    expect(emailSender()).toEqual({ email: 'noreply@kortix.com', name: 'Kortix' });
  });

  test('the sender reaches the provider payload', async () => {
    mockConfig.EMAIL_URL = 'resend://re_key';
    mockConfig.EMAIL_FROM = 'Acme <no-reply@acme.test>';
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'resend', status: 200 });
    expect(JSON.parse(String(calls[0]!.init.body)).from).toBe('Acme <no-reply@acme.test>');
  });

  test('a failing provider falls through to the next in the chain', async () => {
    mockConfig.EMAIL_URL = 'resend://re_key,mailtrap://tok';
    responder = (url) =>
      url.includes('resend') ? new Response('nope', { status: 403 }) : new Response('{}', { status: 200 });
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'mailtrap', status: 200 });
    expect(calls).toHaveLength(2);
  });
});

describe('pre-EMAIL_URL SMTP variables', () => {
  test('SMTP_* is used when listed in EMAIL_PROVIDER_ORDER', () => {
    mockConfig.SMTP_HOST = 'smtp.example.com';
    mockConfig.SMTP_PORT = '587';
    mockConfig.SMTP_USER = 'alice';
    mockConfig.SMTP_PASS = 'secret';
    mockConfig.EMAIL_PROVIDER_ORDER = 'smtp';
    expect(configuredEmailProviders()).toEqual(['smtp']);
  });

  // The upgrade path for a self-host that configured SMTP for GoTrue before
  // EMAIL_URL existed: product email starts working with no new setting.
  test('a GoTrue-only SMTP relay is picked up by the DEFAULT provider order', () => {
    mockConfig.SMTP_HOST = 'smtp.example.com';
    mockConfig.SMTP_PORT = '587';
    mockConfig.SMTP_USER = 'alice';
    mockConfig.SMTP_PASS = 'secret';
    mockConfig.EMAIL_PROVIDER_ORDER = '';
    expect(configuredEmailProviders()).toEqual(['smtp']);
  });

  // A self-host created before EMAIL_URL shipped carries this inert quartet so
  // GoTrue can boot. Treating it as configured would turn a clean
  // `email_not_configured` skip into connection-refused on every invite.
  test('the self-host placeholder quartet is NOT a configured provider', () => {
    mockConfig.SMTP_HOST = 'localhost';
    mockConfig.SMTP_USER = 'unused';
    mockConfig.SMTP_PASS = 'unused';
    mockConfig.EMAIL_PROVIDER_ORDER = 'smtp';
    expect(isEmailConfigured()).toBe(false);
  });
});
