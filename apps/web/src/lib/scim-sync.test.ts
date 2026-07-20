import { describe, expect, it } from 'bun:test';
import type { ScimToken } from './iam-client';
import { latestScimSyncAt, scimSyncFreshness } from './scim-sync';

const token = (over: Partial<ScimToken>): ScimToken => ({
  token_id: 't1',
  name: 'Test',
  public_prefix: 'kortix_scim_AbCd…',
  status: 'active',
  created_at: '2026-07-01T00:00:00Z',
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  ...over,
});

describe('latestScimSyncAt', () => {
  it('returns null with no tokens or no usage', () => {
    expect(latestScimSyncAt([])).toBeNull();
    expect(latestScimSyncAt([token({ last_used_at: null })])).toBeNull();
  });

  it('picks the newest last_used_at across active tokens', () => {
    const tokens = [
      token({ token_id: 'a', last_used_at: '2026-07-19T10:00:00Z' }),
      token({ token_id: 'b', last_used_at: '2026-07-20T09:30:00Z' }),
      token({ token_id: 'c', last_used_at: '2026-07-18T23:00:00Z' }),
    ];
    expect(latestScimSyncAt(tokens)).toBe('2026-07-20T09:30:00Z');
  });

  it('ignores revoked and expired tokens — a rotated-away token must not fake health', () => {
    const tokens = [
      token({ token_id: 'a', status: 'revoked', last_used_at: '2026-07-20T09:30:00Z' }),
      token({ token_id: 'b', status: 'expired', last_used_at: '2026-07-20T08:00:00Z' }),
      token({ token_id: 'c', status: 'active', last_used_at: '2026-07-19T10:00:00Z' }),
    ];
    expect(latestScimSyncAt(tokens)).toBe('2026-07-19T10:00:00Z');
    // Only dead tokens → no sync signal at all.
    expect(latestScimSyncAt(tokens.slice(0, 2))).toBeNull();
  });

  it('skips unparseable timestamps', () => {
    expect(latestScimSyncAt([token({ last_used_at: 'not-a-date' })])).toBeNull();
  });
});

describe('scimSyncFreshness', () => {
  const now = new Date('2026-07-20T12:00:00Z').getTime();

  it('never — no usage or unparseable', () => {
    expect(scimSyncFreshness(null, now)).toBe('never');
    expect(scimSyncFreshness('not-a-date', now)).toBe('never');
  });

  it('live under 5 minutes', () => {
    expect(scimSyncFreshness('2026-07-20T11:56:01Z', now)).toBe('live');
  });

  it('recent under an hour (covers Entra’s ~40-minute cycle)', () => {
    expect(scimSyncFreshness('2026-07-20T11:20:00Z', now)).toBe('recent');
  });

  it('quiet beyond an hour — a fact, not an alarm (event-driven IdPs)', () => {
    expect(scimSyncFreshness('2026-07-20T09:00:00Z', now)).toBe('quiet');
    expect(scimSyncFreshness('2026-07-01T00:00:00Z', now)).toBe('quiet');
  });
});
