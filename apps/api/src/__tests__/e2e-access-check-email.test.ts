import { beforeEach, describe, expect, mock, test } from 'bun:test';

let existingEmails = new Set<string>();
let signupsOpen = true;
let allowlisted = new Set<string>();
let ssoProvidersByDomain = new Map<string, { enforceSso: boolean }>();

mock.module('../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://mocked',
    KORTIX_CHECK_EMAIL_REQS_PER_MIN: 1000,
  },
}));

mock.module('postgres', () => {
  const factory = () => {
    const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const email = String(values[0] ?? '').toLowerCase();
      return Promise.resolve(existingEmails.has(email) ? [{ exists: 1 }] : []);
    };
    sql.end = async () => {};
    return sql;
  };
  return { default: factory };
});

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({ values: async () => {} }),
  },
}));

mock.module('../shared/access-control-cache', () => ({
  areSignupsEnabled: () => signupsOpen,
  canSignUp: (email: string) => signupsOpen || allowlisted.has(email.toLowerCase()),
  startAccessControlCache: () => {},
  stopAccessControlCache: () => {},
}));

mock.module('../repositories/sso', () => ({
  getSsoProviderByDomain: async (domain: string) =>
    ssoProvidersByDomain.get(domain.toLowerCase()) ?? null,
}));

const { accessControlApp } = await import('../access-control/index');

async function checkEmail(email: string) {
  const res = await accessControlApp.request('/check-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /access/check-email unified auth-flow modes', () => {
  beforeEach(() => {
    existingEmails = new Set();
    signupsOpen = true;
    allowlisted = new Set();
    ssoProvidersByDomain = new Map();
  });

  test('existing account resolves to signin even when signups are closed', async () => {
    existingEmails.add('known@acme.com');
    signupsOpen = false;
    const { status, body } = await checkEmail('known@acme.com');
    expect(status).toBe(200);
    expect(body).toEqual({ allowed: true, mode: 'signin' });
  });

  test('new address with open signups resolves to signup', async () => {
    const { status, body } = await checkEmail('new@acme.com');
    expect(status).toBe(200);
    expect(body).toEqual({ allowed: true, mode: 'signup' });
  });

  test('new address with closed signups and no allowlist resolves to closed', async () => {
    signupsOpen = false;
    const { status, body } = await checkEmail('new@acme.com');
    expect(status).toBe(200);
    expect(body).toEqual({ allowed: false, mode: 'closed' });
  });

  test('allowlisted address keeps signup open while signups are closed', async () => {
    signupsOpen = false;
    allowlisted.add('vip@acme.com');
    const { body } = await checkEmail('vip@acme.com');
    expect(body).toEqual({ allowed: true, mode: 'signup' });
  });

  test('enforced SSO domain wins over everything, including existing accounts', async () => {
    ssoProvidersByDomain.set('acme.com', { enforceSso: true });
    existingEmails.add('known@acme.com');
    const { body } = await checkEmail('known@acme.com');
    expect(body).toEqual({ allowed: true, mode: 'sso' });
  });

  test('non-enforced SSO domain falls through to the normal modes', async () => {
    ssoProvidersByDomain.set('acme.com', { enforceSso: false });
    existingEmails.add('known@acme.com');
    const { body } = await checkEmail('known@acme.com');
    expect(body).toEqual({ allowed: true, mode: 'signin' });
  });

  test('invalid email is rejected with 400', async () => {
    const { status } = await checkEmail('not-an-email');
    expect(status).toBe(400);
  });
});
