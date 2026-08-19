import { describe, expect, test } from 'bun:test';

import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import {
  UNSUPPORTED_SECRET_DELIVERY_MESSAGE,
  INVALID_SECRET_BOUNDARY_POLICY_MESSAGE,
  SANDBOX_PROVIDER_CAPACITY_MESSAGE,
  SANDBOX_PROVIDER_FAILURE_MESSAGE,
  classifySandboxProvisioningFailure,
} from './sandbox-provisioning-error';

describe('classifySandboxProvisioningFailure', () => {
  test.each([
    'you have reached the maximum number of concurrent E2B sandboxes (8)',
    'max number of running sandboxes on node reached',
    'too many sandboxes starting on this node',
    'No available runners can satisfy the request',
    '429 Too Many Requests',
    '500: Failed to place sandbox',
  ])('maps provider capacity text to one provider-neutral contract: %s', (message) => {
    expect(classifySandboxProvisioningFailure(new Error(message))).toEqual({
      category: 'provider-capacity',
      userMessage: SANDBOX_PROVIDER_CAPACITY_MESSAGE,
      isCapacity: true,
      isGitAuth: false,
    });
  });

  test('keeps Git authentication failures separate from provider failures', () => {
    const result = classifySandboxProvisioningFailure(
      new Error('fatal: could not read Username for https://github.com: terminal prompts disabled'),
    );

    expect(result.category).toBe('git-auth');
    expect(result.userMessage).toContain("project's Git credentials");
  });

  test('does not expose an unknown provider error to the user', () => {
    const secretProviderMessage = 'SDK failure: credential=do-not-show';
    const result = classifySandboxProvisioningFailure(new Error(secretProviderMessage));

    expect(result).toEqual({
      category: 'sandbox-provider',
      userMessage: SANDBOX_PROVIDER_FAILURE_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
    });
    expect(result.userMessage).not.toContain(secretProviderMessage);
  });

  test('returns an actionable contract when the provider cannot enforce protected delivery', () => {
    const result = classifySandboxProvisioningFailure(
      new Error('Sandbox provider daytona does not support network-boundary secret delivery'),
    );

    // Compared against the CONSTANT, not a second copy of the sentence. The
    // literal used to be duplicated here, so editing the user-facing copy broke
    // this test for no reason a reader could see — and a grep for the constant's
    // name did not find this file. The wording itself is asserted in
    // sandbox-provisioning-error.remedy.test.ts, which is where it belongs.
    expect(result).toEqual({
      category: 'unsupported-secret-delivery',
      userMessage: UNSUPPORTED_SECRET_DELIVERY_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
    });
  });

  // Two secrets claiming the same (host, header) used to land in 'sandbox-provider', whose copy
  // blames the provider and says "Try again" — verified live on dev, where every new session in the
  // project failed with exactly that. Retrying can never clear a config conflict.
  test('classifies a host+header collision as an unretryable project config error', () => {
    const result = classifySandboxProvisioningFailure(
      new Error(
        'Network-boundary secrets BOUNDARY_TEST and BOUNDARY_TEST2 both target postman-echo.com header authorization',
      ),
    );

    expect(result.category).toBe('invalid-secret-boundary-policy');
    expect(result.userMessage).toBe(INVALID_SECRET_BOUNDARY_POLICY_MESSAGE);
    expect(result.isCapacity).toBe(false);
    expect(result.isGitAuth).toBe(false);
  });

  test.each([
    ['Network-boundary secret STRIPE has an invalid consumer'],
    ['Network-boundary secret STRIPE has no outbound policy'],
    ['STRIPE: Network-boundary delivery requires exact hosts'],
    ['STRIPE: Network-boundary delivery cannot enforce path restrictions'],
    ['STRIPE: invalid header injection'],
  ])('classifies %s as an unretryable project config error', (message) => {
    expect(classifySandboxProvisioningFailure(new Error(message)).category).toBe(
      'invalid-secret-boundary-policy',
    );
  });

  // The provider-capability gap and the project-config error are different problems with different
  // fixes, so one must never absorb the other.
  test('keeps the provider capability gap distinct from a bad project policy', () => {
    expect(
      classifySandboxProvisioningFailure(
        new Error('Sandbox provider daytona does not support network-boundary secret delivery'),
      ).category,
    ).toBe('unsupported-secret-delivery');
  });

  test('leaves an ordinary provider failure unclassified', () => {
    expect(
      classifySandboxProvisioningFailure(new Error('upstream returned 500')).category,
    ).toBe('sandbox-provider');
  });

  /**
   * Drives the REAL validator rather than a copy of its strings, so a rule added to
   * `networkBoundaryPolicyError` cannot quietly fall through to "Try again." A hardcoded list would
   * still pass while the new message went unclassified — which is exactly how the collision shipped.
   */
  test('classifies every message the boundary validator can produce', () => {
    const base = {
      rules: [{ host: 'api.example.com' }],
      inject: { kind: 'header' as const, name: 'authorization', template: 'Bearer {{secret}}' },
    };
    const invalidPolicies = [
      { ...base, backend: 'kortix_fetch' },
      { ...base, on_no_match: 'allow' },
      { ...base, tls: 'passthrough' },
      { ...base, inject: { kind: 'query' as const, name: 'token' } },
      { ...base, rules: [{ host: '*.example.com' }] },
      { ...base, rules: [{ host: 'api.example.com', methods: ['GET'] }] },
      { ...base, rules: [{ host: 'api.example.com', path: '/v1' }] },
    ];

    const produced = invalidPolicies
      .map((policy) => networkBoundaryPolicyError(policy as never))
      .filter((message): message is string => message !== null);

    // Every entry above must actually be rejected; otherwise this test proves nothing.
    expect(produced).toHaveLength(invalidPolicies.length);

    for (const message of produced) {
      expect(classifySandboxProvisioningFailure(new Error(`STRIPE: ${message}`)).category).toBe(
        'invalid-secret-boundary-policy',
      );
    }
  });
});
