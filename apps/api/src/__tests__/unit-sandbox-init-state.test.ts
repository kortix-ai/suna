import { describe, expect, test } from 'bun:test';

import {
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

  test('marks successful initialization as ready', () => {
    const meta = buildSandboxInitSuccessMetadata({ serverType: 'basic' }, { provisioningStage: 'server_creating' }, 2);
    expect(meta.initStatus).toBe('ready');
    expect(meta.initAttempts).toBe(2);
    expect(meta.serverType).toBe('basic');
  });

  test('retries provider create up to success', async () => {
    let attempts = 0;
    const provider = {
      name: 'justavps',
      provisioning: { async: true, stages: [] },
      async create() {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt-${attempts}`);
        return { externalId: 'machine-123', baseUrl: 'https://sandbox.example', metadata: { justavpsSlug: 'abc' } };
      },
      async start() {},
      async stop() {},
      async remove() {},
      async getStatus() { return 'unknown' as const; },
      async resolveEndpoint() { return { url: '', headers: {} }; },
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
});
