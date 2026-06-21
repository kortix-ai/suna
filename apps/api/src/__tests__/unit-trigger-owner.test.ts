import { describe, expect, it } from 'bun:test';
import { chooseTriggerActor } from '../projects/lib/triggers';

// The trigger-owner escape hatch: a trigger fires AS its configured owner so a
// per_user connector resolves to THAT member's accounts — but only while the
// owner is still a member; otherwise it falls back to the account owner.
describe('chooseTriggerActor', () => {
  const ACCOUNT_OWNER = 'acct-owner-user';
  const OWNER = 'owner-user';

  it('runs as the owner when set and still a member', () => {
    expect(chooseTriggerActor(OWNER, true, ACCOUNT_OWNER)).toBe(OWNER);
  });

  it('falls back to the account owner when the configured owner left the account', () => {
    expect(chooseTriggerActor(OWNER, false, ACCOUNT_OWNER)).toBe(ACCOUNT_OWNER);
  });

  it('falls back to the account owner when no owner is configured (legacy triggers)', () => {
    expect(chooseTriggerActor(null, false, ACCOUNT_OWNER)).toBe(ACCOUNT_OWNER);
  });

  it('ignores a stale member flag when there is no owner', () => {
    // ownerIsMember can never be true with a null owner, but guard the contract.
    expect(chooseTriggerActor(null, true, ACCOUNT_OWNER)).toBe(ACCOUNT_OWNER);
  });

  it('returns null only when neither an eligible owner nor an account owner exists', () => {
    expect(chooseTriggerActor(null, false, null)).toBeNull();
    expect(chooseTriggerActor(OWNER, false, null)).toBeNull();
  });

  it('prefers the owner even when an account owner is also present', () => {
    expect(chooseTriggerActor(OWNER, true, ACCOUNT_OWNER)).not.toBe(ACCOUNT_OWNER);
  });
});
