import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let sandboxRow: {
  provider: string;
  externalId: string;
  metadata: Record<string, unknown> | null;
} | null = null;
let updateCalls = 0;
const setPayloads: unknown[] = [];

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (sandboxRow ? [sandboxRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        updateCalls += 1;
        setPayloads.push(payload);
        return {
          where: () => ({
            returning: async () =>
              sandboxRow
                ? [{ provider: sandboxRow.provider, externalId: sandboxRow.externalId }]
                : [],
          }),
        };
      },
    }),
  },
}));

mock.module('../platform/providers', () => ({
  getProvider: () => ({
    resolveEndpoint: async () => ({ url: 'https://sandbox.example.test', headers: {} }),
  }),
}));

const { acquireExecutionLease, renewExecutionLease } = await import('./execution-lease');

const target = {
  sandboxId: 'sandbox-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  accountId: 'account-1',
};

function containsString(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsString(item, needle, depth + 1),
  );
}

const NOW = new Date('2026-07-29T20:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const ENV_KEYS = [
  'KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES',
  'KORTIX_EXECUTION_LEASE_CEILING_ENABLED',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  updateCalls = 0;
  setPayloads.length = 0;
  sandboxRow = { provider: 'daytona', externalId: 'sandbox-ext-1', metadata: null };
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('writeExecutionLease no longer forges lastTurnAt', () => {
  test('a renew writes the lease but never touches the activity clock', async () => {
    sandboxRow = {
      provider: 'daytona',
      externalId: 'sandbox-ext-1',
      metadata: { executionLeaseStartedAt: hoursAgo(1), lastTurnAt: hoursAgo(9) },
    };

    const result = await renewExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(true);
    expect(updateCalls).toBe(1);
    expect(containsString(setPayloads[0], 'executionLeaseUntil')).toBe(true);
    expect(containsString(setPayloads[0], 'lastTurnAt')).toBe(false);
  });

  test('an acquire writes the lease but never touches the activity clock', async () => {
    const result = await acquireExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(true);
    expect(updateCalls).toBe(1);
    expect(containsString(setPayloads[0], 'lastTurnAt')).toBe(false);
  });
});

describe('writeExecutionLease enforces the cumulative ceiling', () => {
  test('renews normally while the lease is inside the ceiling', async () => {
    sandboxRow = {
      provider: 'daytona',
      externalId: 'sandbox-ext-1',
      metadata: { executionLeaseStartedAt: hoursAgo(5) },
    };

    const result = await renewExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(true);
    expect(result.leaseUntil).toBe('2026-07-29T20:03:00.000Z');
    expect(updateCalls).toBe(1);
  });

  test('refuses to renew past the ceiling and issues no write at all', async () => {
    sandboxRow = {
      provider: 'daytona',
      externalId: 'sandbox-ext-1',
      metadata: { executionLeaseStartedAt: hoursAgo(7) },
    };

    const result = await renewExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(false);
    expect(result.leaseUntil).toBeNull();
    expect(updateCalls).toBe(0);
  });

  test('refuses an acquire past the ceiling too, so release-and-reacquire cannot reset it', async () => {
    sandboxRow = {
      provider: 'daytona',
      externalId: 'sandbox-ext-1',
      metadata: { executionLeaseStartedAt: hoursAgo(264), executionLeaseUntil: null },
    };

    const result = await acquireExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(false);
    expect(updateCalls).toBe(0);
  });

  test('the kill switch restores the old unbounded behaviour', async () => {
    process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED = 'false';
    sandboxRow = {
      provider: 'daytona',
      externalId: 'sandbox-ext-1',
      metadata: { executionLeaseStartedAt: hoursAgo(264) },
    };

    const result = await renewExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(true);
    expect(updateCalls).toBe(1);
  });

  test('a missing sandbox row is refused without a write', async () => {
    sandboxRow = null;

    const result = await renewExecutionLease(target, 180, NOW);

    expect(result.ok).toBe(false);
    expect(updateCalls).toBe(0);
  });
});
