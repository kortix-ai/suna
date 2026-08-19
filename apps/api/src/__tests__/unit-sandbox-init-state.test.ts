import { describe, expect, test } from 'bun:test';

import {
  buildSandboxInitAttemptMetadata,
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  deriveSandboxHealthStatus,
  deriveSandboxInitStatus,
  retrySandboxProvisionCreate,
} from '../platform/services/sandbox-init-state';

describe('sandbox init state helpers', () => {
  test('derives init and health states separately', () => {
    expect(deriveSandboxInitStatus('error', {})).toBe('failed');
    expect(deriveSandboxHealthStatus('error', {})).toBe('unknown');
    expect(deriveSandboxInitStatus('active', {})).toBe('ready');
    expect(deriveSandboxHealthStatus('stopped', {})).toBe('offline');
  });

  test('marks final init failure with explicit retry guidance', () => {
    const meta = buildSandboxInitFailureMetadata({}, new Error('boom'), 3, false);
    expect(meta.initStatus).toBe('failed');
    expect(meta.lastInitError).toBe('boom');
    expect(meta.errorMessage).toBe('Initialization failed after 3 attempts. Reinitialize to retry.');
  });

  test('records the active capacity retry limit in retry metadata', () => {
    const attempt = buildSandboxInitAttemptMetadata({}, 18, 'retrying', null, null, 30);
    const failure = buildSandboxInitFailureMetadata({}, new Error('rate limit'), 18, true, 30);
    const success = buildSandboxInitSuccessMetadata({}, {}, 18, 30);

    expect(attempt.initMaxAttempts).toBe(30);
    expect(failure.initMaxAttempts).toBe(30);
    expect(success.initMaxAttempts).toBe(30);
  });

  test('marks successful initialization as ready', () => {
    const meta = buildSandboxInitSuccessMetadata({ serverType: 'basic' }, { provisioningStage: 'server_creating' }, 2);
    expect(meta.initStatus).toBe('ready');
    expect(meta.initAttempts).toBe(2);
    expect(meta.serverType).toBe('basic');
  });

  test('retries provider create up to success', async () => {
    let attempts = 0;
    const provider = {
      name: 'daytona' as const,
      provisioning: { async: true, stages: [] },
      async create() {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt-${attempts}`);
        return { externalId: 'machine-123', baseUrl: 'https://sandbox.example', metadata: { daytonaSandboxId: 'abc' } };
      },
      async ensureAppRuntimeStarted() {},
      async start() {},
      async renewLifecycle() {},
      async stop() {},
      async remove() {},
      async getStatus() { return 'unknown' as const; },
      async resolveEndpoint() { return { url: '', headers: {} }; },
      routeIngress(request: { port: number }) { return { effectivePort: request.port }; },
      async resolveIngress(_externalId: string, request: { port: number }) { return { url: '', headers: {}, effectivePort: request.port }; },
      async ensureRunning() {},
      async getProvisioningStatus() { return null; },
    };

    const result = await retrySandboxProvisionCreate(provider, {
      accountId: 'acct',
      userId: 'user',
      name: 'sandbox',
    });

    expect(result.attempts).toBe(3);
    expect(result.result.externalId).toBe('machine-123');
  });

  test('fails deterministic provider capacity after one create call', async () => {
    let attempts = 0;
    const failures: Array<{ attempt: number; willRetry: boolean; maxAttempts: number }> = [];
    const provider = {
      name: 'e2b' as const,
      provisioning: { async: true, stages: [] },
      async create() {
        attempts += 1;
        throw new Error('Maximum number of concurrent E2B sandboxes reached');
      },
      async ensureAppRuntimeStarted() {},
      async start() {},
      async renewLifecycle() {},
      async stop() {},
      async remove() {},
      async getStatus() { return 'unknown' as const; },
      async resolveEndpoint() { return { url: '', headers: {} }; },
      routeIngress(request: { port: number }) { return { effectivePort: request.port }; },
      async resolveIngress(_externalId: string, request: { port: number }) { return { url: '', headers: {}, effectivePort: request.port }; },
      async ensureRunning() {},
      async getProvisioningStatus() { return null; },
    };

    await expect(
      retrySandboxProvisionCreate(
        provider,
        { accountId: 'acct', userId: 'user', name: 'sandbox' },
        {
          onAttemptFailure: (attempt, _error, willRetry, maxAttempts) => {
            failures.push({ attempt, willRetry, maxAttempts });
          },
        },
      ),
    ).rejects.toThrow('Maximum number of concurrent E2B sandboxes reached');

    expect(attempts).toBe(1);
    expect(failures).toEqual([{ attempt: 1, willRetry: false, maxAttempts: 1 }]);
  });
});
