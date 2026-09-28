/**
 * A parked session must not be reported as a bad token.
 *
 * A session credential is authority for ONE live sandbox: `validateAccountToken`
 * refuses it the moment that sandbox row leaves `provisioning`/`active`. Every
 * path that parks a row mid-turn therefore withdraws the credential of a box
 * that is still running, and the gateway answered `Invalid token` — which is
 * false. The token is valid and unexpired; its lease was withdrawn.
 *
 * Measured on a real dev session, 2026-09-28: a turn died with `Invalid token`
 * on a box whose daemon reported healthy. That message sends whoever reads it
 * to check API keys, which is the wrong system.
 */

import { describe, expect, test } from 'bun:test';

import { SESSION_LEASE_REFUSAL } from './session-lease-refusal';
import { tokenRefusalReason } from './session-lease-refusal';

describe('tokenRefusalReason', () => {
  test('names the SANDBOX for a withdrawn session lease', () => {
    const reason = tokenRefusalReason(SESSION_LEASE_REFUSAL);
    expect(reason).toBeString();
    expect(reason).toContain('session is no longer running');
    // The whole point: it must not send the reader after the credential.
    expect(reason).not.toContain('Invalid token');
  });

  test('every other refusal stays the generic unknown-token answer', () => {
    // These are real refusals from validateAccountToken. None of them is about
    // a sandbox, so none may borrow the sandbox message.
    for (const other of ['PAT expired', 'Invalid token id', 'revoked', 'not found']) {
      expect(tokenRefusalReason(other)).toBeNull();
    }
    expect(tokenRefusalReason(null)).toBeNull();
    expect(tokenRefusalReason(undefined)).toBeNull();
    expect(tokenRefusalReason('')).toBeNull();
  });

  test('the constant is shared, not a re-typed literal', () => {
    // If someone reworded the refusal in account-tokens.ts and this mapping
    // used its own copy of the string, a parked session would silently go back
    // to reporting `Invalid token`. The import is what prevents that; this
    // asserts the constant still carries the value the gate returns.
    expect(SESSION_LEASE_REFUSAL).toBe('Session token is not active');
  });
});
