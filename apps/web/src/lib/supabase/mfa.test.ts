import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { AALResponse, FactorInfo } from './mfa';
// mfaChallengeRequired is imported dynamically inside its describe block so a
// missing export fails with a clear message instead of killing the whole file.

// ─── Supabase client stub ───────────────────────────────────────────────────
// `getAAL` reads `supabase.auth.getSession`, `supabase.auth.getUser` and
// `supabase.auth.mfa.getAuthenticatorAssuranceLevel`. Mock `./client` before
// the module under test is imported, then drive each branch from the holders
// below (the repo pattern: mock.module + dynamic import).
type FakeFactor = FactorInfo;

let session: unknown;
let aal: {
  data?: {
    currentLevel?: string | null;
    nextLevel?: string | null;
    currentAuthenticationMethods?: Array<{ method: string }>;
  } | null;
  error?: { message: string } | null;
};
let user: { created_at?: string; factors?: FakeFactor[] } | null;
let userError: { message: string } | null;

mock.module('./client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session } }),
      getUser: async () => ({ data: { user }, error: userError }),
      mfa: { getAuthenticatorAssuranceLevel: async () => aal },
    },
  }),
}));

const { supabaseMFAService, mfaChallengeRequired } = await import('./mfa');

const CUTOFF_ISO = '2025-12-24T00:09:30.000Z';

/** Sign in a user created at `created_at` holding `factors`, at level aal1→aal1. */
function signIn(created_at: string, factors: FakeFactor[] = []) {
  session = { user: { id: 'u' } };
  aal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
  user = { created_at, factors };
  userError = null;
}

beforeEach(() => {
  session = null;
  aal = { data: null, error: null };
  user = null;
  userError = null;
  delete process.env.NEXT_PUBLIC_PHONE_NUMBER_MANDATORY;
});

describe('getAAL with no session', () => {
  test('returns the safe defaults object unchanged', async () => {
    session = null;

    expect(await supabaseMFAService.getAAL()).toEqual({
      current_level: 'aal1',
      next_level: 'aal1',
      current_authentication_methods: [],
      action_required: 'none',
      phone_verification_required: false,
      user_created_at: undefined,
      cutoff_date: CUTOFF_ISO,
      verification_required: false,
      is_verified: false,
      factors: [],
    });
  });
});

describe('getAAL AAL combinations', () => {
  // A user created before the cutoff, phone verification not mandatory: the
  // AAL pair alone decides `action_required` and `message`.
  const COMBOS: Array<[string | null, string | null, string, string]> = [
    ['aal1', 'aal1', 'none', 'MFA is not enrolled for this account'],
    ['aal1', 'aal2', 'verify_mfa', 'MFA verification required to access full features'],
    ['aal2', 'aal2', 'none', 'MFA is verified and active'],
    ['aal2', 'aal1', 'reauthenticate', 'Session needs refresh due to MFA changes'],
    [null, null, 'unknown', 'Unknown AAL combination: null -> null'],
  ];

  for (const [current, next, actionRequired, message] of COMBOS) {
    test(`${current}→${next} reports "${actionRequired}"`, async () => {
      signIn('2025-01-01T00:00:00.000Z');
      aal = { data: { currentLevel: current, nextLevel: next }, error: null };

      const result: AALResponse = await supabaseMFAService.getAAL();

      expect(result.action_required).toBe(actionRequired);
      expect(result.message).toBe(message);
      expect(result.current_level).toBe(current ?? undefined);
      expect(result.next_level).toBe(next ?? undefined);
    });
  }

  test('maps currentAuthenticationMethods to their method names', async () => {
    signIn('2025-01-01T00:00:00.000Z');
    aal = {
      data: {
        currentLevel: 'aal2',
        nextLevel: 'aal2',
        currentAuthenticationMethods: [{ method: 'sms' }, { method: 'password' }],
      },
      error: null,
    };

    const result = await supabaseMFAService.getAAL();
    expect(result.current_authentication_methods).toEqual(['sms', 'password']);
  });
});

describe('getAAL phone factors', () => {
  test('a verified phone factor sets is_verified and passes factors through', async () => {
    const factors: FakeFactor[] = [
      { id: 'f-totp', factor_type: 'totp', status: 'verified' },
      { id: 'f-phone', factor_type: 'phone', status: 'verified', phone: '+15550000000' },
    ];
    signIn('2025-01-01T00:00:00.000Z', factors);

    const result = await supabaseMFAService.getAAL();

    expect(result.is_verified).toBe(true);
    expect(result.factors).toEqual(factors);
  });

  test('an unverified phone factor leaves is_verified false, factors still listed', async () => {
    const factors: FakeFactor[] = [
      { id: 'f-phone', factor_type: 'phone', status: 'unverified', phone: '+15550000000' },
    ];
    signIn('2025-01-01T00:00:00.000Z', factors);

    const result = await supabaseMFAService.getAAL();

    expect(result.is_verified).toBe(false);
    expect(result.factors).toEqual(factors);
  });

  test('no factors at all: is_verified false and an empty factors list', async () => {
    signIn('2025-01-01T00:00:00.000Z');

    const result = await supabaseMFAService.getAAL();

    expect(result.is_verified).toBe(false);
    expect(result.factors).toEqual([]);
  });
});

describe('getAAL cutoff boundary and mandatory flag', () => {
  test('a user created exactly at the cutoff is a new user', async () => {
    process.env.NEXT_PUBLIC_PHONE_NUMBER_MANDATORY = 'true';
    signIn(CUTOFF_ISO);

    const result = await supabaseMFAService.getAAL();

    expect(result.phone_verification_required).toBe(true);
    expect(result.verification_required).toBe(true);
    expect(result.user_created_at).toBe(CUTOFF_ISO);
  });

  test('a user created one millisecond before the cutoff is grandfathered', async () => {
    process.env.NEXT_PUBLIC_PHONE_NUMBER_MANDATORY = 'true';
    signIn('2025-12-24T00:09:29.999Z');

    const result = await supabaseMFAService.getAAL();

    expect(result.phone_verification_required).toBe(false);
    expect(result.verification_required).toBe(false);
  });

  test('without the mandatory flag a new user needs no verification', async () => {
    signIn('2026-01-01T00:00:00.000Z');

    const result = await supabaseMFAService.getAAL();

    expect(result.phone_verification_required).toBe(false);
    expect(result.verification_required).toBe(false);
  });
});

describe('getAAL error paths', () => {
  test('an AAL error is wrapped as "Failed to get AAL: <message>"', async () => {
    signIn('2025-01-01T00:00:00.000Z');
    aal = { data: null, error: { message: 'upstream down' } };

    expect(supabaseMFAService.getAAL()).rejects.toThrow('Failed to get AAL: upstream down');
  });

  test('a getUser error is wrapped the same way', async () => {
    signIn('2025-01-01T00:00:00.000Z');
    userError = { message: 'no user row' };

    expect(supabaseMFAService.getAAL()).rejects.toThrow('Failed to get AAL: no user row');
  });

  test('a missing user is wrapped the same way', async () => {
    signIn('2025-01-01T00:00:00.000Z');
    user = null;

    expect(supabaseMFAService.getAAL()).rejects.toThrow('Failed to get AAL: User not found');
  });
});

/**
 * `mfaChallengeRequired` decides when a session must pass a TOTP challenge
 * before the app grants access: a verified TOTP factor is enrolled, but the
 * session itself is still at aal1 (a fresh first-factor sign-in). This is the
 * KRTX-1386 gate: an enrolled factor that never re-asks protects nothing.
 */
describe('mfaChallengeRequired', () => {

  const totp = (status: string) => ({ id: 'f-totp', factor_type: 'totp', status });
  const phone = (status: string) => ({ id: 'f-phone', factor_type: 'phone', status });

  test('aal1 → aal2 with a verified TOTP factor: challenge required', () => {
    expect(mfaChallengeRequired({ current_level: 'aal1', next_level: 'aal2', factors: [totp('verified')] })).toBe(true);
  });

  test('aal2 → aal2 (already verified this session): no challenge', () => {
    expect(mfaChallengeRequired({ current_level: 'aal2', next_level: 'aal2', factors: [totp('verified')] })).toBe(false);
  });

  test('aal1 → aal1 (nothing verified enrolled): no challenge', () => {
    expect(mfaChallengeRequired({ current_level: 'aal1', next_level: 'aal1', factors: [] })).toBe(false);
  });

  test('an unverified TOTP factor (enrollment in progress) does not enforce', () => {
    expect(mfaChallengeRequired({ current_level: 'aal1', next_level: 'aal1', factors: [totp('unverified')] })).toBe(false);
  });

  test('a verified phone factor alone does not enforce (its challenge needs an SMS round trip)', () => {
    expect(mfaChallengeRequired({ current_level: 'aal1', next_level: 'aal2', factors: [phone('verified')] })).toBe(false);
  });

  test('no AAL answer yet does not enforce', () => {
    expect(mfaChallengeRequired(undefined)).toBe(false);
  });

  test('the aal2 answer of a no-session account never enforces', () => {
    // getAAL returns these exact safe defaults before a session exists.
    expect(
      mfaChallengeRequired({
        current_level: 'aal1',
        next_level: 'aal1',
        current_authentication_methods: [],
        action_required: 'none',
        phone_verification_required: false,
        user_created_at: undefined,
        cutoff_date: CUTOFF_ISO,
        verification_required: false,
        is_verified: false,
        factors: [],
      }),
    ).toBe(false);
  });
});
