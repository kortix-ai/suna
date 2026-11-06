/**
 * Every credential the API accepts, as an Artifact live socket re-checks it
 * (Strix: sockets outliving a service-account, OAuth or browser credential).
 * One table (`LIVE_AUTH_TYPES`, typed over every `authType`) maps each kind to
 * the source of its expiry and the read that proves it is not revoked. These
 * tests walk the whole table: a kind added later is covered, or fails here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const NOW = Date.now();
const LATER = new Date(NOW + 30 * 60_000);
const EARLIER = new Date(NOW - 1_000);
type Scenario = 'live' | 'revoked' | 'expired' | 'unavailable';
let scenario: Scenario = 'live';

mock.module('../shared/jwt-liveness', () => ({
  authSessionLive: async () => {
    if (scenario === 'unavailable') throw new Error('auth.sessions unavailable');
    return scenario === 'live';
  },
}));
mock.module('../oauth/access-token', () => ({
  readOAuthAccessTokenState: async () => {
    if (scenario === 'unavailable') throw new Error('oauth store unavailable');
    return { revokedAt: scenario === 'revoked' ? EARLIER : null, expiresAt: scenario === 'expired' ? EARLIER : LATER, clientActive: true };
  },
}));
mock.module('../repositories/account-tokens', () => ({
  validateAccountTokenById: async () => {
    if (scenario === 'unavailable') return { isValid: false, error: 'Validation error' };
    if (scenario === 'live') return { isValid: true, expiresAt: LATER };
    return { isValid: false, credentialDead: true, error: scenario };
  },
}));
mock.module('../repositories/service-accounts', () => ({
  readServiceAccountState: async () => {
    if (scenario === 'unavailable') throw new Error('service accounts unavailable');
    return { status: scenario === 'revoked' ? 'disabled' : 'active', expiresAt: scenario === 'expired' ? EARLIER : LATER };
  },
}));

const { LIVE_AUTH_TYPES, LIVE_CREDENTIALS, inspectLiveCredential, liveCredentialKind } = await import('./live-credential');

const USER = '80000000-0000-4000-8000-000000000001';
const ACCOUNT = '80000000-0000-4000-8000-000000000002';
const ID = '80000000-0000-4000-8000-000000000003';
const kinds = Object.keys(LIVE_CREDENTIALS) as Array<keyof typeof LIVE_CREDENTIALS>;

beforeEach(() => {
  scenario = 'live';
});

describe('the live-socket credential table', () => {
  test('every authType the API accepts maps to a re-checked credential kind, or is refused', () => {
    expect(Object.keys(LIVE_AUTH_TYPES).sort()).toEqual(['apiKey', 'oauth', 'pat', 'service_account', 'supabase']);
    expect(liveCredentialKind('supabase', 'jwt')).toBe('browser_session');
    expect(liveCredentialKind('oauth', 'jwt')).toBe('oauth');
    expect(liveCredentialKind('pat', 'pat')).toBe('pat');
    expect(liveCredentialKind('pat', 'agent_session')).toBe('agent_session');
    expect(liveCredentialKind('service_account', 'service_account')).toBe('service_account');
    // A sandbox / legacy API key carries no identity to re-check: no ticket.
    expect(liveCredentialKind('apiKey', 'sandbox')).toBeNull();
    expect(liveCredentialKind(undefined, 'jwt')).toBeNull();
    // Each mapped authType names only kinds the table re-checks.
    for (const mapped of Object.values(LIVE_AUTH_TYPES)) {
      for (const kind of mapped ?? []) expect(kinds).toContain(kind);
    }
  });

  test('every kind names where its expiry comes from and how its revocation is read', () => {
    expect(kinds.sort()).toEqual(['agent_session', 'browser_session', 'oauth', 'pat', 'service_account']);
    for (const kind of kinds) {
      expect(LIVE_CREDENTIALS[kind].expiry.length).toBeGreaterThan(10);
      expect(LIVE_CREDENTIALS[kind].revocation.length).toBeGreaterThan(10);
    }
  });

  test.each(['agent_session', 'browser_session', 'oauth', 'pat', 'service_account'] as const)('%s: live with its expiry; revoked and expired are refused; a failed read throws', async (kind) => {
    const ref = { kind, id: ID };
    scenario = 'live';
    const live = await inspectLiveCredential(ref, { userId: USER, accountId: ACCOUNT });
    expect(live.live).toBe(true);
    // A browser session's expiry is the JWT's `exp`, read at the mint; every row-backed kind reports its own.
    if (kind !== 'browser_session') expect(live.expiresAt).toBe(LATER.getTime());
    for (const dead of ['revoked', 'expired'] as const) {
      scenario = dead;
      if (kind === 'browser_session' && dead === 'expired') continue; // the JWT's `exp`, enforced by the socket's own cutoff
      expect((await inspectLiveCredential(ref, { userId: USER, accountId: ACCOUNT })).live).toBe(false);
    }
    scenario = 'unavailable';
    await expect(inspectLiveCredential(ref, { userId: USER, accountId: ACCOUNT })).rejects.toThrow();
  });

  test('a credential without an id is refused, except a browser session that predates session ids', async () => {
    for (const kind of kinds) {
      const verdict = await inspectLiveCredential({ kind, id: null }, { userId: USER, accountId: ACCOUNT });
      expect(verdict.live).toBe(kind === 'browser_session');
    }
  });
});
