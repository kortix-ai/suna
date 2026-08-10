import { describe, expect, test } from 'bun:test';

import {
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

    expect(result).toEqual({
      category: 'unsupported-secret-delivery',
      userMessage:
        'This sandbox provider cannot enforce network-boundary secret delivery. Select Platinum or change the secret delivery policy.',
      isCapacity: false,
      isGitAuth: false,
    });
  });
});
