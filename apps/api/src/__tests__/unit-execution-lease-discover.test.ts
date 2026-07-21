import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DaytonaRateLimitError } from '@daytonaio/sdk';
import { primeDaytonaRateLimitClassifier } from '../shared/daytona-rate-limit';

// Regression for the `execution_lease_discover` path on
// Better Stack pattern `ec26b248…` (`DaytonaRateLimitError: ThrottlerException:
// Too Many Requests`). `discoverExecutionKeepAliveEndpoint` previously called
// `provider.resolveEndpoint` UNGUARDED — a Daytona org-wide 429 on that call
// propagated to `app.onError` → `captureException` → Sentry → Better Stack. The
// fix wraps the call so an expected provider 429 degrades to `null` (the
// caller treats null as "no keep-alive endpoint yet", exactly like
// `touchProvider`'s own catch). This test proves that contract.

beforeAll(async () => {
  await primeDaytonaRateLimitClassifier();
});

// `mock.module` is hoisted before the SUT import; capture the throw into a
// mutable holder so each test can swap the failure mode.
let resolveEndpointThrow: unknown = null;
let resolveEndpointCalls = 0;

mock.module('../platform/providers', () => ({
  getProvider: () => ({
    resolveEndpoint: async (_externalId: string) => {
      resolveEndpointCalls += 1;
      if (resolveEndpointThrow) throw resolveEndpointThrow;
      return { url: 'https://upstream.example.test/', headers: { 'x-test': '1' } };
    },
  }),
}));

// Drizzle query-builder chain: .select(...).from(...).where(...).limit(1)
// returns the row array when awaited. The SUT only uses loadLeaseSandbox() to
// fetch a single {provider, externalId} row, so the chain returns that shape.
const leaseRow = [{ provider: 'daytona', externalId: 'sb-test-external' }];
const chainable = {
  from: () => chainable,
  where: () => chainable,
  limit: () => leaseRow,
};
mock.module('../shared/db', () => ({
  db: {
    select: () => chainable,
  },
}));

const { discoverExecutionKeepAliveEndpoint } = await import('../projects/execution-lease');

beforeEach(() => {
  resolveEndpointThrow = null;
  resolveEndpointCalls = 0;
});

describe('discoverExecutionKeepAliveEndpoint Daytona 429 guard', () => {
  it('returns null (does NOT throw) when resolveEndpoint throws DaytonaRateLimitError', async () => {
    resolveEndpointThrow = new DaytonaRateLimitError(
      'ThrottlerException: Too Many Requests',
      429,
      undefined,
      'ThrottlerException',
    );
    const result = await discoverExecutionKeepAliveEndpoint({
      sandboxId: 'sb-1',
      sessionId: 'ses-1',
      projectId: 'proj-1',
    });
    expect(result).toBeNull();
    expect(resolveEndpointCalls).toBe(1);
  });

  it('returns null on ANY provider failure (transient outage, archived box, …)', async () => {
    // The contract is best-effort: any provider failure degrades to null so the
    // DB lease (the authoritative source) is what the caller acts on. No
    // failure class escapes to the global error handler.
    resolveEndpointThrow = new Error('Daytona get(sb-test-external) failed: HTTP 503');
    const result = await discoverExecutionKeepAliveEndpoint({
      sandboxId: 'sb-1',
      sessionId: 'ses-1',
      projectId: 'proj-1',
    });
    expect(result).toBeNull();
  });

  it('returns the resolved endpoint on the happy path (no behavior change)', async () => {
    const result = await discoverExecutionKeepAliveEndpoint({
      sandboxId: 'sb-1',
      sessionId: 'ses-1',
      projectId: 'proj-1',
    });
    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://upstream.example.test');
    // Authorization header is stripped (keepAliveEndpoint strips it) —
    // contract preserved across the guard.
    expect(result?.headers.authorization).toBeUndefined();
    expect(result?.headers['x-test']).toBe('1');
  });
});
