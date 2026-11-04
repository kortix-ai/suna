import { beforeEach, describe, expect, mock, test } from 'bun:test';

let signupsOpen = true;
let allowlisted = new Set<string>();
let ssoProvidersByDomain = new Map<string, { enforceSso: boolean; domainVerifiedAt: Date | null }>();

mock.module('../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://mocked',
    KORTIX_CHECK_EMAIL_REQS_PER_MIN: 1000,
  },
}));

// The route still writes access requests; nothing it answers check-email with
// may read the auth database — that lookup was the account-existence oracle.
// The mock answers BOTH ways a re-introduced lookup could see the world — the
// DB claiming the address exists (a row) and the DB unreachable (a throw) —
// and the parity tests below assert the body did not move in either.
let dbAnswer: 'row' | 'throws' = 'row';
mock.module('../shared/db', () => ({
  db: {
    insert: () => ({ values: async () => {} }),
    execute: async () => {
      if (dbAnswer === 'throws') throw new Error('auth database unreachable');
      return [{ found: 1 }];
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

// KRTX-3504: check-email is public and must not distinguish account history.
// Only two things may change a body: instance policy (closed signups, the
// allowlist) or SSO-only sign-in on a verified domain. Eligibility is
// re-enforced at account creation (web actions, headless /auth/signup), and
// the sign-in door exists for every address — GoTrue answers an unknown
// address exactly like a wrong password.
describe('POST /access/check-email', () => {
  beforeEach(() => {
    signupsOpen = true;
    allowlisted = new Set();
    ssoProvidersByDomain = new Map();
    dbAnswer = 'row';
  });

  test('an address the auth DB calls existing and an unknown one answer the identical body (no existence oracle)', async () => {
    // The mock claims EVERY address exists (`dbAnswer: 'row'`) — the strongest
    // possible oracle bait. A re-introduced account lookup that branches on a
    // row answers one probe `mode:"signin"` and the parity assert fails; the
    // handler under test ignores the DB entirely.
    const { body: known } = await checkEmail('known@acme.com');
    const { body: unknown } = await checkEmail('nobody@acme.com');
    expect(known).toEqual({ allowed: true });
    expect(unknown).toEqual({ allowed: true });
  });

  test('an unreachable auth DB cannot change the eligible answer either', async () => {
    // The old lookup swallowed its own errors into `false` — the same swallow
    // must not be able to resurrect a mode behind an unreachable DB.
    dbAnswer = 'throws';
    const { body: known } = await checkEmail('known@acme.com');
    const { body: unknown } = await checkEmail('nobody@acme.com');
    expect(known).toEqual({ allowed: true });
    expect(unknown).toEqual({ allowed: true });
  });

  test('signups open, allowlisted: the eligible answer is the identical mode-less body', async () => {
    signupsOpen = false;
    allowlisted.add('vip@acme.com');
    const { status, body } = await checkEmail('vip@acme.com');
    expect(status).toBe(200);
    expect(body).toEqual({ allowed: true });
  });

  test('signups closed: an existing and a new address answer the identical closed body', async () => {
    signupsOpen = false;
    const { body: known } = await checkEmail('known@acme.com');
    const { body: unknown } = await checkEmail('new@acme.com');
    expect(known).toEqual({ allowed: false, mode: 'closed' });
    expect(unknown).toEqual({ allowed: false, mode: 'closed' });
  });

  test('SSO-only sign-in on a verified domain still comes before everything else', async () => {
    signupsOpen = false;
    ssoProvidersByDomain.set('acme.com', { enforceSso: true, domainVerifiedAt: new Date() });
    const { status, body } = await checkEmail('known@acme.com');
    expect(status).toBe(200);
    expect(body).toEqual({ allowed: true, mode: 'sso' });
  });
});
