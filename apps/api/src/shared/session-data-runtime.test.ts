import { describe, expect, test } from 'bun:test';
import { selectSessionDataRuntime } from './session-data-runtime';

describe('session data runtime target', () => {
  test('uses the environment when the session has one', () => {
    expect(
      selectSessionDataRuntime({
        workerExternalId: 'worker-1',
        workerStatus: 'active',
        environmentExists: true,
        environmentExternalId: 'environment-1',
        environmentStatus: 'active',
      }),
    ).toEqual({ externalId: 'environment-1', status: 'active' });
  });

  test('does not fall back to the worker while the environment provisions', () => {
    expect(
      selectSessionDataRuntime({
        workerExternalId: 'worker-1',
        workerStatus: 'active',
        environmentExists: true,
        environmentExternalId: null,
        environmentStatus: 'provisioning',
      }),
    ).toEqual({ externalId: null, status: 'provisioning' });
  });

  test('keeps one-box sessions on their worker runtime', () => {
    expect(
      selectSessionDataRuntime({
        workerExternalId: 'sandbox-1',
        workerStatus: 'active',
        environmentExists: false,
        environmentExternalId: null,
        environmentStatus: null,
      }),
    ).toEqual({ externalId: 'sandbox-1', status: 'active' });
  });
});
