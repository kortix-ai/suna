import { describe, expect, test } from 'bun:test';

import { provisioningFailurePresentation } from './provisioning-failure';

describe('provisioningFailurePresentation', () => {
  test('shows a specific capacity title and the API-owned message', () => {
    expect(
      provisioningFailurePresentation({
        failureCategory: 'provider-capacity',
        provisioningError: 'provider SDK text that must stay diagnostic-only',
        errorMessage: 'The sandbox provider is at capacity right now. Try again in a minute.',
      }),
    ).toEqual({
      title: 'Sandbox capacity is full',
      message: 'The sandbox provider is at capacity right now. Try again in a minute.',
      retryable: true,
    });
  });

  test('shows Git failures as Git failures', () => {
    const result = provisioningFailurePresentation({
      failureCategory: 'git-auth',
      errorMessage: 'Check the Git credentials.',
    });

    expect(result.title).toBe('Git access failed');
    expect(result.message).toBe('Check the Git credentials.');
  });

  test('uses provider-neutral fallback copy', () => {
    expect(provisioningFailurePresentation({}, 'Essentia runtime')).toEqual({
      title: "Couldn't start Essentia runtime",
      message: 'The sandbox provider could not start this session. Try again.',
      retryable: true,
    });
  });
});
