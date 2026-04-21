import { describe, expect, test } from 'bun:test';

import { nextRecoveredStatus, stripFailureMetadata } from '../platform/services/sandbox-provision-poller';

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
});
