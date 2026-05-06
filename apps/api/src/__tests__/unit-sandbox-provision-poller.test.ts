import { describe, expect, test } from 'bun:test';

import {
  isTerminalProviderFailure,
  nextRecoveredStatus,
  shouldPollProvisioningSandbox,
  stripFailureMetadata,
} from '../platform/services/sandbox-provision-poller';

describe('sandbox provision poller recovery helpers', () => {
  test('strips failure metadata before healing a sandbox', () => {
    expect(stripFailureMetadata({
      provisioningError: 'provider said no',
      lastProvisioningError: 'boom',
      errorMessage: 'Provisioning failed',
      provisioningStage: 'services_ready',
      justavpsSlug: 'abc123',
    })).toEqual({
      provisioningStage: 'services_ready',
      justavpsSlug: 'abc123',
    });
  });

  test('moves errored sandboxes back to provisioning while readiness still warming up', () => {
    expect(nextRecoveredStatus('error', false)).toBe('provisioning');
  });

  test('keeps provisioning sandboxes in provisioning until readiness passes', () => {
    expect(nextRecoveredStatus('provisioning', false)).toBe('provisioning');
  });

  test('marks sandboxes active once readiness passes', () => {
    expect(nextRecoveredStatus('error', true)).toBe('active');
    expect(nextRecoveredStatus('provisioning', true)).toBe('active');
  });

  test('does not keep polling terminal provider failures', () => {
    expect(isTerminalProviderFailure({
      provisioningError: 'Machine not found on provider',
    })).toBe(true);
    expect(isTerminalProviderFailure({
      lastProvisioningError: 'Machine was deleted by the provider',
    })).toBe(true);
    expect(isTerminalProviderFailure({
      errorMessage: 'Machine provisioning failed (cloud_init_failed)',
    })).toBe(true);

    expect(shouldPollProvisioningSandbox({
      status: 'error',
      metadata: { provisioningError: 'Machine not found on provider' },
    })).toBe(false);
  });

  test('still polls retryable errored sandboxes for self-healing', () => {
    expect(shouldPollProvisioningSandbox({
      status: 'error',
      metadata: { provisioningError: 'Sandbox services are still warming up' },
    })).toBe(true);
  });
});
