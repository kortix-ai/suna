// One auth email per address per minute (auth/email-cooldown.ts): check-email
// reports the cooldown to the web form, and the headless signup, magic-link and
// password-reset routes refuse with 429 before GoTrue mails the address again.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { Hono } from 'hono';

mock.module('../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://mocked',
    SUPABASE_URL: 'http://supabase.internal:8000',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-jwt',
    FRONTEND_URL: 'https://app.example',
    KORTIX_CHECK_EMAIL_REQS_PER_MIN: 1000,
  },
}));

/** auth.users as the cooldown query sees it: email → seconds since the newest auth email. */
let users = new Map<string, number | null>();
let dbDown = false;
mock.module('../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  db: {
    execute: async (query: SQL) => {
      if (dbDown) throw new Error('connection refused');
      const email = new PgDialect().sqlToQuery(query).params[0] as string;
      return users.has(email) ? [{ found: 1, email_age_seconds: users.get(email) }] : [];
    },
  },
}));
mock.module('../middleware/auth-audit', () => ({
  auditLoginFail: () => {},
  auditLoginSuccess: () => {},
  auditLogout: () => {},
  auditSessionFirstSight: () => {},
}));
const realAccessControl = await import('../shared/access-control-cache');
mock.module('../shared/access-control-cache', () => ({
  ...realAccessControl,
  areSignupsEnabled: () => true,
  canSignUp: () => true,
}));
const realSso = await import('../repositories/sso');
mock.module('../repositories/sso', () => ({ ...realSso, ssoEnforcedForEmail: async () => null }));

const { retryAfterFromAge, authEmailState } = await import('../auth/email-cooldown');
const { accessControlApp } = await import('../access-control/index');
const gotrueModule = await import('../auth/gotrue');
const { headlessAuthRouter } = await import('../auth/headless');

let gotrueCalls: string[] = [];
gotrueModule.__setGoTrueFetch(async (input) => {
  gotrueCalls.push(input);
  return Response.json({ id: 'u1', email: 'a@b.test' });
});

const app = new Hono();
app.route('/v1/access', accessControlApp);
app.route('/v1/auth', headlessAuthRouter);
let ip = 0;
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    // A fresh client IP per call: the per-IP limiters are not under test.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${(ip++ % 250) + 1}` },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  users = new Map();
  dbDown = false;
  gotrueCalls = [];
});

describe('retryAfterFromAge', () => {
  test('counts down the minute from the newest auth email', () => {
    expect(retryAfterFromAge(0)).toBe(60);
    expect(retryAfterFromAge(12.4)).toBe(48);
    expect(retryAfterFromAge(59.5)).toBe(1);
  });
  test('no cooldown once the minute is over, or when no email was ever sent', () => {
    expect(retryAfterFromAge(60)).toBeNull();
    expect(retryAfterFromAge(3600)).toBeNull();
    expect(retryAfterFromAge(null)).toBeNull();
    expect(retryAfterFromAge(undefined)).toBeNull();
  });
  test('a timestamp ahead of the database clock is a full cooldown, not a negative one', () => {
    expect(retryAfterFromAge(-5)).toBe(60);
  });
});

describe('authEmailState', () => {
  test('a database failure fails open: no account, no cooldown', async () => {
    dbDown = true;
    expect(await authEmailState('a@b.test')).toEqual({ exists: false, retryAfterSeconds: null });
  });
});

describe('POST /v1/access/check-email', () => {
  test('an existing address mailed 20 s ago reports 40 s of cooldown', async () => {
    users.set('pending@b.test', 20);
    const res = await post('/v1/access/check-email', { email: 'Pending@B.test' });
    expect(await res.json()).toEqual({ allowed: true, mode: 'signin', email_retry_after_seconds: 40 });
  });
  test('an existing address with no recent email has no cooldown field', async () => {
    users.set('known@b.test', 900);
    const res = await post('/v1/access/check-email', { email: 'known@b.test' });
    expect(await res.json()).toEqual({ allowed: true, mode: 'signin' });
  });
});

describe('headless email-sending routes', () => {
  for (const [path, body] of [
    ['/v1/auth/signup', { email: 'pending@b.test', password: 'synthetic-password' }],
    ['/v1/auth/sign-in/magic-link', { email: 'pending@b.test' }],
    ['/v1/auth/password/reset', { email: 'pending@b.test' }],
  ] as const) {
    test(`${path} answers 429 over_email_send_rate_limit inside the cooldown and never calls GoTrue`, async () => {
      users.set('pending@b.test', 5);
      const res = await post(path, body);
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('55');
      expect(((await res.json()) as { error: string }).error).toBe('over_email_send_rate_limit');
      expect(gotrueCalls).toEqual([]);
    });
    test(`${path} reaches GoTrue once the cooldown is over`, async () => {
      users.set('pending@b.test', 61);
      const res = await post(path, body);
      expect(res.status).toBe(200);
      expect(gotrueCalls).toHaveLength(1);
    });
  }
});
