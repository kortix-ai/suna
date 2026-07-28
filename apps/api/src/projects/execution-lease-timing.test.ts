import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getContextFields, runWithContext } from '../lib/request-context';

let leaseRow: { provider: string; externalId: string } | null = {
  provider: 'daytona',
  externalId: 'sandbox-ext-1',
};
let resolvedEndpoint: { url: string; headers: Record<string, string> } = {
  url: 'https://sandbox.example.com',
  headers: {},
};
let resolveEndpointSpy: () => void = () => {};

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (leaseRow ? [leaseRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => (leaseRow ? [leaseRow] : []),
        }),
      }),
    }),
  },
}));

mock.module('../platform/providers', () => ({
  getProvider: () => ({
    resolveEndpoint: async () => {
      resolveEndpointSpy();
      return resolvedEndpoint;
    },
  }),
}));

const { discoverExecutionKeepAliveEndpoint, renewExecutionLease } = await import(
  './execution-lease'
);

const realFetch = globalThis.fetch;

beforeEach(() => {
  leaseRow = { provider: 'daytona', externalId: 'sandbox-ext-1' };
  resolvedEndpoint = { url: 'https://sandbox.example.com', headers: {} };
  resolveEndpointSpy = () => {};
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const target = {
  sandboxId: 'sandbox-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  accountId: 'account-1',
};

describe('execution-lease provider timing fields', () => {
  test('discover records provider_get_ms and preview_link_ms on the request context', async () => {
    await runWithContext('POST', '/v1/projects/project-1/turn-stream', async () => {
      await discoverExecutionKeepAliveEndpoint(target);
      const fields = getContextFields();
      expect(fields.provider_get_ms).toBeDefined();
      expect(fields.preview_link_ms).toBeDefined();
      expect(Number.isFinite(Number(fields.provider_get_ms))).toBe(true);
      expect(Number.isFinite(Number(fields.preview_link_ms))).toBe(true);
    });
  });

  test('heartbeat renew does no provider work at all', async () => {
    let resolveCalls = 0;
    resolveEndpointSpy = () => {
      resolveCalls += 1;
    };

    await runWithContext('POST', '/v1/projects/project-1/turn-stream', async () => {
      const result = await renewExecutionLease(target);
      const fields = getContextFields();
      expect(resolveCalls).toBe(0);
      expect(fields.provider_get_ms).toBeUndefined();
      expect(fields.preview_link_ms).toBeUndefined();
      expect(result.providerUrl).toBeNull();
    });
  });

  test('no request context in flight means the fields are dropped, not thrown', async () => {
    await expect(discoverExecutionKeepAliveEndpoint(target)).resolves.not.toBeNull();
  });
});
