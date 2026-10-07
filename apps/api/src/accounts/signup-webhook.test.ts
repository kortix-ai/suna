import { afterEach, describe, expect, test } from 'bun:test';

import { config } from '../config';
import { verifyWebhookSignature } from '../projects/lib/trigger-webhook-auth';
import { buildSignupEvent, sendSignupWebhook } from './signup-webhook';

const signup = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example-corp.test',
  name: 'Ada Lovelace',
};
const createdAt = new Date('2026-10-07T12:00:00.000Z');

describe('buildSignupEvent', () => {
  test('business email carries kind, domain, name, provider', () => {
    expect(buildSignupEvent({ ...signup, authProvider: 'google', createdAt })).toEqual({
      event: 'account.signup',
      user_id: signup.userId,
      email: 'ada@example-corp.test',
      email_kind: 'business',
      email_domain: 'example-corp.test',
      name: 'Ada Lovelace',
      auth_provider: 'google',
      created_at: '2026-10-07T12:00:00.000Z',
    });
  });

  test('consumer email is personal; missing name and provider are null', () => {
    const event = buildSignupEvent({
      ...signup,
      email: 'ada@gmail.com',
      name: null,
      authProvider: null,
      createdAt,
    });
    expect(event).toMatchObject({
      email_kind: 'personal',
      email_domain: 'gmail.com',
      name: null,
      auth_provider: null,
    });
  });
});

describe('sendSignupWebhook', () => {
  const realFetch = globalThis.fetch;
  const saved = {
    SIGNUP_WEBHOOK_URL: config.SIGNUP_WEBHOOK_URL,
    SIGNUP_WEBHOOK_SECRET: config.SIGNUP_WEBHOOK_SECRET,
  };
  const provider = async () => 'github';

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(config, saved);
  });

  function configure() {
    Object.assign(config, {
      SIGNUP_WEBHOOK_URL: 'https://hooks.example.test/signup',
      SIGNUP_WEBHOOK_SECRET: 'test-secret',
    });
  }

  function mockReceiver(statuses: number[]) {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response('{}', { status: statuses[Math.min(calls.length, statuses.length) - 1] });
    }) as unknown as typeof fetch;
    return calls;
  }

  test('unset URL is a no-op: no request', async () => {
    Object.assign(config, { SIGNUP_WEBHOOK_URL: undefined, SIGNUP_WEBHOOK_SECRET: undefined });
    const calls = mockReceiver([202]);
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(false);
    expect(calls.length).toBe(0);
  });

  test('posts one event signed with HMAC-SHA256 of the exact raw body', async () => {
    configure();
    const calls = mockReceiver([202]);
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(true);
    expect(calls.length).toBe(1);
    const { url, headers, body } = calls[0]!;
    expect(url).toBe('https://hooks.example.test/signup');
    expect(headers.get('content-type')).toBe('application/json');
    // The receiving trigger's own verifier accepts it.
    expect(headers.get('x-kortix-signature')).toStartWith('sha256=');
    expect(verifyWebhookSignature(body, 'test-secret', headers.get('x-kortix-signature'))).toBe(true);
    expect(verifyWebhookSignature(body, 'wrong-secret', headers.get('x-kortix-signature'))).toBe(false);
    // Retries of one signup dedupe on the receiver.
    expect(headers.get('x-kortix-delivery-id')).toBe(`account.signup:${signup.userId}`);
    expect(JSON.parse(body)).toMatchObject({
      event: 'account.signup',
      user_id: signup.userId,
      email_kind: 'business',
      auth_provider: 'github',
    });
  });

  test('5xx retries 3 times then gives up without throwing', async () => {
    configure();
    const calls = mockReceiver([502]);
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(false);
    expect(calls.length).toBe(3);
  });

  test('4xx fails fast; a later 2xx after a 5xx succeeds', async () => {
    configure();
    const rejected = mockReceiver([401]);
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(false);
    expect(rejected.length).toBe(1);

    const recovered = mockReceiver([503, 202]);
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(true);
    expect(recovered.length).toBe(2);
  });

  test('network errors retry and never throw', async () => {
    configure();
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await sendSignupWebhook(signup, 1, provider)).toBe(false);
    expect(attempts).toBe(3);
  });
});
