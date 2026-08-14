/**
 * The remedy sentence a user sees when a session cannot provision because the
 * provider has no credential edge.
 *
 * It is pinned because it went stale silently once. It read "Select Platinum or
 * change the secret delivery policy" — written when Platinum was the only
 * mechanism. On a deployment that ships no Platinum that left the reader one
 * impossible option and one destructive one, and it never learned about the
 * `network_boundary_shim` flag that is now the cheapest fix. Nothing failed;
 * the sentence was simply wrong for anyone who read it.
 */
import { describe, expect, test } from 'bun:test';
import {
  UNSUPPORTED_SECRET_DELIVERY_MESSAGE,
  classifySandboxProvisioningFailure,
} from './sandbox-provisioning-error';

describe('the unsupported-delivery remedy names every way out', () => {
  test('it offers the flag, Platinum, and changing the policy', () => {
    expect(UNSUPPORTED_SECRET_DELIVERY_MESSAGE).toContain('Network boundary without Platinum');
    expect(UNSUPPORTED_SECRET_DELIVERY_MESSAGE).toContain('Platinum');
    expect(UNSUPPORTED_SECRET_DELIVERY_MESSAGE).toContain('delivery policy');
  });

  test('it does not present Platinum as the only option', () => {
    // The exact old sentence. A deployment without Platinum cannot act on it.
    expect(UNSUPPORTED_SECRET_DELIVERY_MESSAGE).not.toContain(
      'Select Platinum or change the secret delivery policy',
    );
  });

  test('the raw provisioning throw is what maps to it', () => {
    // The classifier is the ONLY reason the raw string never reaches a client,
    // which is what makes the message above the thing users actually read — a
    // dev-verification script grepping for the raw throw found nothing.
    const failure = classifySandboxProvisioningFailure(
      new Error('Sandbox provider daytona does not support network-boundary secret delivery'),
    );
    expect(failure.category).toBe('unsupported-secret-delivery');
    expect(failure.userMessage).toBe(UNSUPPORTED_SECRET_DELIVERY_MESSAGE);
  });
});
