import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  EMAIL_PROVIDER_ORDER: 'ses,resend,mailtrap',
  AWS_SES_REGION: 'us-east-2',
  AWS_SES_ACCESS_KEY_ID: '',
  AWS_SES_SECRET_ACCESS_KEY: '',
  RESEND_API_KEY: '',
  RESEND_FROM_EMAIL: '',
  MAILTRAP_API_TOKEN: '',
  MAILTRAP_FROM_EMAIL: 'noreply@example.test',
  MAILTRAP_FROM_NAME: 'Kortix Test',
};

mock.module('../../config', () => ({
  config: mockConfig,
}));

const { configuredEmailProviders, isEmailConfigured, sendEmail } = await import('./transport');

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];
let responder: (url: string) => Response;

beforeEach(() => {
  calls = [];
  responder = () => new Response('{}', { status: 200 });
  mockConfig.EMAIL_PROVIDER_ORDER = 'ses,resend,mailtrap';
  mockConfig.AWS_SES_ACCESS_KEY_ID = '';
  mockConfig.AWS_SES_SECRET_ACCESS_KEY = '';
  mockConfig.RESEND_API_KEY = '';
  mockConfig.RESEND_FROM_EMAIL = '';
  mockConfig.MAILTRAP_API_TOKEN = '';
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const MSG = {
  to: ['user@example.test'],
  subject: 'Test',
  html: '<p>hello</p>',
  category: 'unit-test',
};

describe('configuredEmailProviders', () => {
  test('empty when no provider credentials are set', () => {
    expect(configuredEmailProviders()).toEqual([]);
    expect(isEmailConfigured()).toBe(false);
  });

  test('respects EMAIL_PROVIDER_ORDER and filters unconfigured providers', () => {
    mockConfig.MAILTRAP_API_TOKEN = 'mt-token';
    mockConfig.RESEND_API_KEY = 're_test';
    mockConfig.EMAIL_PROVIDER_ORDER = 'mailtrap,resend,ses';
    expect(configuredEmailProviders()).toEqual(['mailtrap', 'resend']);
  });
});

describe('sendEmail', () => {
  test('skips with email_not_configured when no provider is set', async () => {
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: false, skipped: true, reason: 'email_not_configured' });
    expect(calls).toHaveLength(0);
  });

  test('ses leg signs the SESv2 request with SigV4', async () => {
    mockConfig.AWS_SES_ACCESS_KEY_ID = 'AKIATEST';
    mockConfig.AWS_SES_SECRET_ACCESS_KEY = 'secret';
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'ses', status: 200 });
    expect(calls[0].url).toBe('https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.FromEmailAddress).toBe('Kortix Test <noreply@example.test>');
    expect(payload.Destination.ToAddresses).toEqual(['user@example.test']);
    expect(payload.EmailTags).toEqual([{ Name: 'category', Value: 'unit-test' }]);
  });

  test('resend leg sends the Resend payload with the category tag', async () => {
    mockConfig.RESEND_API_KEY = 're_test';
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'resend', status: 200 });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.from).toBe('Kortix Test <noreply@example.test>');
    expect(payload.to).toEqual(['user@example.test']);
    expect(payload.reply_to).toBeUndefined();
    expect(payload.tags).toEqual([{ name: 'category', value: 'unit-test' }]);
  });

  test('resend leg substitutes RESEND_FROM_EMAIL and keeps the intended sender as reply_to', async () => {
    mockConfig.RESEND_API_KEY = 're_test';
    mockConfig.RESEND_FROM_EMAIL = 'noreply@fallback.test';
    await sendEmail(MSG);
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.from).toBe('Kortix Test <noreply@fallback.test>');
    expect(payload.reply_to).toBe('noreply@example.test');
  });

  test('falls through the chain: ses failure → resend failure → mailtrap success', async () => {
    mockConfig.AWS_SES_ACCESS_KEY_ID = 'AKIATEST';
    mockConfig.AWS_SES_SECRET_ACCESS_KEY = 'secret';
    mockConfig.RESEND_API_KEY = 're_test';
    mockConfig.MAILTRAP_API_TOKEN = 'mt-token';
    responder = (url) =>
      url.includes('mailtrap') ? new Response('{}', { status: 200 }) : new Response('nope', { status: 403 });
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'mailtrap', status: 200 });
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      'email.us-east-2.amazonaws.com',
      'api.resend.com',
      'send.api.mailtrap.io',
    ]);
  });

  test('returns the last failure when every provider fails', async () => {
    mockConfig.AWS_SES_ACCESS_KEY_ID = 'AKIATEST';
    mockConfig.AWS_SES_SECRET_ACCESS_KEY = 'secret';
    mockConfig.MAILTRAP_API_TOKEN = 'mt-token';
    responder = () => new Response('boom', { status: 500 });
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: false, provider: 'mailtrap', status: 500, error: 'boom' });
  });

  test('a thrown network error falls through to the next provider', async () => {
    mockConfig.AWS_SES_ACCESS_KEY_ID = 'AKIATEST';
    mockConfig.AWS_SES_SECRET_ACCESS_KEY = 'secret';
    mockConfig.MAILTRAP_API_TOKEN = 'mt-token';
    let first = true;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (first) {
        first = false;
        throw new Error('connect ECONNREFUSED');
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendEmail(MSG);
    expect(result).toEqual({ ok: true, provider: 'mailtrap', status: 200 });
  });
});
