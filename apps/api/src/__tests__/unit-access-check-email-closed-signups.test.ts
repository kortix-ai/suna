import { beforeEach, describe, expect, mock, test } from 'bun:test';

let existingEmails = new Set<string>();
let signupsOpen = true;
let allowlisted = new Set<string>();
let ssoProvidersByDomain = new Map<string, { enforceSso: boolean; domainVerifiedAt: Date | null }>();

mock.module('../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://mocked',
    KORTIX_CHECK_EMAIL_REQS_PER_MIN: 1000,
  },
}));

// userExistsInAuth reads auth.users through the shared pool: answer from the
// email value interpolated into the query.
mock.module('../shared/db', () => ({
  db: {
    insert: () => ({ values: async () => {} }),
    execute: async (query: { queryChunks?: unknown[] }) => {
      const values = (query.queryChunks ?? []).filter((chunk): chunk is string => typeof chunk === 'string');
      return values.some((value) => existingEmails.has(value.toLowerCase())) ? [{ found: 1 }] : [];
    },
  },
}));

mock.module('../shared/access-control-cache', () => ({
  areSignupsEnabled: () => signupsOpen,
  canSignUp: (email: string) => signupsOpen || allowlisted.has(email.toLowerCase()),
  refreshAccessControlCache: async () => {},
}));

// The same rule as the real `ssoEnforcedForEmail`: enforcement needs a
// verified domain. The DB-backed rule is exercised end to end by flow SSO-1.
mock.module('../repositories/sso', () => ({
  ssoEnforcedForEmail: async (email: string) => {
    const provider = ssoProvidersByDomain.get(email.trim().toLowerCase().split('@')[1] ?? '');
    return provider?.enforceSso && provider.domainVerifiedAt ? provider : null;
  },
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

// ACC-2, SSO-1 and SSO-3 (tests/src/flows) assert the open-signup and SSO modes
// over real HTTP. Closing signups flips a process-wide flag every parallel flow
// reads, so the closed-signup precedence stays here: an existing account still
// signs in, an allowlisted address still signs up, everyone else is closed.
describe('POST /access/check-email while signups are closed', () => {
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
});
