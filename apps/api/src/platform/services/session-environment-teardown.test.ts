import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionEnvironments } from '@kortix/db';

let row: Record<string, unknown> | null;
let providerStopError: Error | null;
let providerStatus: 'running' | 'stopped' | 'removed' | 'unknown';
let providerStopCalls: string[];
let providerStatusCalls: string[];
let meterEndCalls: string[];
let updates: Record<string, unknown>[];

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === sessionEnvironments && row ? [row] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            return row ? [{ ...row, ...values }] : [];
          },
        }),
      }),
    }),
  },
}));

mock.module('../providers', () => ({
  getProvider: () => ({
    stop: async (externalId: string) => {
      providerStopCalls.push(externalId);
      if (providerStopError) throw providerStopError;
    },
    getStatus: async (externalId: string) => {
      providerStatusCalls.push(externalId);
      return providerStatus;
    },
  }),
}));

mock.module('../../shared/daytona', () => ({
  getDaytona: () => ({
    get: async (externalId: string) => ({ id: externalId, state: providerStatus }),
    stop: async (sandbox: { id: string }) => {
      providerStopCalls.push(sandbox.id);
      if (providerStopError) throw providerStopError;
    },
  }),
}));

mock.module('../../shared/with-timeout', () => ({
  withTimeout: async <T>(promise: Promise<T>) => promise,
}));

mock.module('../../billing/services/compute-metering', () => ({
  endComputeSession: async (environmentId: string) => {
    meterEndCalls.push(environmentId);
  },
}));

mock.module('../../repositories/account-tokens', () => ({
  revokeAccountToken: async () => undefined,
}));

const { stopSessionEnvironment } = await import('./session-environment-teardown');

beforeEach(() => {
  row = {
    sessionId: 'session-1',
    environmentId: 'environment-1',
    accountId: 'account-1',
    projectId: 'project-1',
    provider: 'daytona',
    status: 'active',
    externalId: 'external-1',
    metadata: {},
    config: {},
  };
  providerStopError = null;
  providerStatus = 'running';
  providerStopCalls = [];
  providerStatusCalls = [];
  meterEndCalls = [];
  updates = [];
});

describe('stopSessionEnvironment', () => {
  test('keeps the row active and the meter open when the provider still reports running', async () => {
    providerStopError = new Error('provider unavailable');

    await expect(stopSessionEnvironment('session-1')).rejects.toThrow(
      'Environment external-1 is still running after its stop failed',
    );

    expect(providerStopCalls).toEqual(['external-1']);
    expect(providerStatusCalls).toEqual(['external-1']);
    expect(meterEndCalls).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('reconciles a failed stop only after the provider confirms the box is stopped', async () => {
    providerStopError = new Error('not stoppable');
    providerStatus = 'stopped';

    const result = await stopSessionEnvironment('session-1');

    expect(result?.status).toBe('stopped');
    expect(providerStatusCalls).toEqual(['external-1']);
    expect(meterEndCalls).toEqual(['environment-1']);
    expect(updates).toHaveLength(1);
  });

  test('clears a provider-confirmed removed box so the next ensure rebuilds it', async () => {
    providerStopError = new Error('not found');
    providerStatus = 'removed';

    const result = await stopSessionEnvironment('session-1');

    expect(result?.status).toBe('stopped');
    expect(result?.externalId).toBeNull();
    expect(providerStatusCalls).toEqual(['external-1']);
    expect(meterEndCalls).toEqual(['environment-1']);
    expect(updates).toEqual([
      expect.objectContaining({ status: 'stopped', externalId: null, baseUrl: null }),
    ]);
  });

  test('stops an existing provider box while its row is provisioning', async () => {
    row = { ...(row ?? {}), status: 'provisioning' };

    const result = await stopSessionEnvironment('session-1');

    expect(result?.status).toBe('stopped');
    expect(providerStopCalls).toEqual(['external-1']);
    expect(meterEndCalls).toEqual(['environment-1']);
  });

  test('closes the meter and row after a successful provider stop', async () => {
    const result = await stopSessionEnvironment('session-1');

    expect(result?.status).toBe('stopped');
    expect(providerStopCalls).toEqual(['external-1']);
    expect(providerStatusCalls).toEqual([]);
    expect(meterEndCalls).toEqual(['environment-1']);
    expect(updates).toHaveLength(1);
  });
});
