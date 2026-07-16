import { afterEach, describe, expect, test } from 'bun:test';

import { config } from '../config';
import {
  planSignupContact,
  syncSignupContactToMailtrap,
} from './mailtrap-contacts';
import { classifyEmailKind, emailDomain, isWorkEmail } from './personal-email';

describe('personal-email classification', () => {
  test('consumer providers are personal', () => {
    for (const email of [
      'jane@gmail.com',
      'jane@GMAIL.com',
      ' jane@outlook.com ',
      'jane@icloud.com',
      'jane@proton.me',
      'jane@yopmail.com',
    ]) {
      expect(classifyEmailKind(email)).toBe('personal');
    }
  });

  test('company domains are business', () => {
    for (const email of ['jane@acme.com', 'cto@startup.io', 'ops@kortix.ai']) {
      expect(classifyEmailKind(email)).toBe('business');
    }
  });

  test('unparseable addresses are never work emails', () => {
    expect(isWorkEmail(null)).toBe(false);
    expect(isWorkEmail(undefined)).toBe(false);
    expect(isWorkEmail('not-an-email')).toBe(false);
    expect(isWorkEmail('trailing@')).toBe(false);
  });

  test('emailDomain extracts the lowercased domain after the last @', () => {
    expect(emailDomain('Jane@Acme.COM')).toBe('acme.com');
    expect(emailDomain('a@b@corp.dev')).toBe('corp.dev');
    expect(emailDomain('nodomain')).toBe(null);
  });
});

describe('planSignupContact', () => {
  const cfg = { signupsListId: '386118', businessListId: '386119' };

  test('business signup lands on both lists', () => {
    const plan = planSignupContact('cto@acme.com', cfg);
    expect(plan.kind).toBe('business');
    expect(plan.listIds).toEqual([386118, 386119]);
  });

  test('personal signup lands only on the all-signups list', () => {
    const plan = planSignupContact('jane@gmail.com', cfg);
    expect(plan.kind).toBe('personal');
    expect(plan.listIds).toEqual([386118]);
  });

  test('unset or malformed list ids are dropped, never sent as NaN', () => {
    expect(planSignupContact('cto@acme.com', {}).listIds).toEqual([]);
    expect(
      planSignupContact('cto@acme.com', { signupsListId: 'oops', businessListId: '7' }).listIds,
    ).toEqual([7]);
  });
});

describe('syncSignupContactToMailtrap', () => {
  const realFetch = globalThis.fetch;
  const configured = !!(config.MAILTRAP_API_TOKEN && config.MAILTRAP_ACCOUNT_ID);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockMailtrap(
    responses: Array<{ status: number; body?: string }>,
  ): Array<{ url: string; body: unknown }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return new Response(next?.body ?? '{}', { status: next?.status ?? 500 });
    }) as unknown as typeof fetch;
    return calls;
  }

  test('missing email is skipped without a request', async () => {
    const calls = mockMailtrap([{ status: 200 }]);
    const result = await syncSignupContactToMailtrap(null, 1);
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test.if(configured)('posts the contact with the planned list ids', async () => {
    const calls = mockMailtrap([{ status: 200 }]);
    const result = await syncSignupContactToMailtrap('cto@acme.com', 1);
    expect(result).toMatchObject({ ok: true, kind: 'business', alreadyExisted: false });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      `https://mailtrap.io/api/accounts/${config.MAILTRAP_ACCOUNT_ID}/contacts`,
    );
    const contact = (calls[0]?.body as { contact: { email: string; list_ids: number[] } })
      .contact;
    expect(contact.email).toBe('cto@acme.com');
  });

  test.if(configured)('422 already-exists counts as success, no retries', async () => {
    const calls = mockMailtrap([{ status: 422, body: '{"errors":{"email":["has already been taken"]}}' }]);
    const result = await syncSignupContactToMailtrap('cto@acme.com', 1);
    expect(result).toMatchObject({ ok: true, alreadyExisted: true });
    expect(calls.length).toBe(1);
  });

  test.if(configured)('5xx retries then reports failure', async () => {
    const calls = mockMailtrap([{ status: 502, body: 'bad gateway' }]);
    const result = await syncSignupContactToMailtrap('cto@acme.com', 1);
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(3);
    expect((result as { error: string }).error).toContain('502');
  });

  test.if(configured)('other 4xx fails fast without retries', async () => {
    const calls = mockMailtrap([{ status: 401, body: 'unauthorized' }]);
    const result = await syncSignupContactToMailtrap('cto@acme.com', 1);
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(1);
  });
});
