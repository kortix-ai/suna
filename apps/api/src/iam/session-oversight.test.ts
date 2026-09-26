import { describe, expect, test } from 'bun:test';
import { OVERSIGHT_ACCOUNT_ROLES, sessionOversightFrom } from './session-oversight';

// The account-level "admins can open every session" policy: who it reaches.
describe('sessionOversightFrom', () => {
  test('an account admin holds oversight while the policy is on', () => {
    expect(sessionOversightFrom({ policyEnabled: true, callerIsAccountAdmin: true })).toBe(true);
  });

  test('nobody holds oversight while the policy is off (the default)', () => {
    expect(sessionOversightFrom({ policyEnabled: false, callerIsAccountAdmin: true })).toBe(false);
  });

  test('a plain member never holds oversight', () => {
    expect(sessionOversightFrom({ policyEnabled: true, callerIsAccountAdmin: false })).toBe(false);
  });

  test('oversight reaches exactly the owner and admin account roles', () => {
    expect([...OVERSIGHT_ACCOUNT_ROLES]).toEqual(['owner', 'admin']);
  });
});
