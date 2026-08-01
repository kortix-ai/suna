import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayRequestLogs, projectSessions, sandboxComputeSessions } from '@kortix/db';

type QueryRecord = {
  fields: Record<string, unknown>;
  table: unknown;
  calls: Array<{ method: string; args: unknown[] }>;
};

let queryRecords: QueryRecord[] = [];
let resultForQuery: (fields: Record<string, unknown>, table: unknown) => unknown[] = () => [];

function createQueryBuilder(record: QueryRecord, rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of [
    'innerJoin',
    'leftJoin',
    'where',
    'groupBy',
    'orderBy',
    'limit',
    'offset',
  ]) {
    builder[method] = (...args: unknown[]) => {
      record.calls.push({ method, args });
      return builder;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: The Drizzle query mock must be awaitable.
  builder.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return builder;
}

mock.module('./db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const record: QueryRecord = { fields, table, calls: [] };
        queryRecords.push(record);
        return createQueryBuilder(record, resultForQuery(fields, table));
      },
    }),
  },
}));

mock.module('../projects/lib/access', () => ({
  resolveSessionOwnerIdentities: async (ownerIds: string[]) =>
    new Map(
      ownerIds.map((ownerId) => [
        ownerId,
        {
          type: 'user' as const,
          name: 'Owner One',
          email: 'owner@example.com',
        },
      ]),
    ),
}));

const { getSessionCostRecord, listProjectGatewaySessionSpend, listSessionCosts } = await import(
  './session-costs'
);

const accountId = '00000000-0000-4000-a000-000000000001';
const projectId = '00000000-0000-4000-a000-000000000002';
const ownerId = '00000000-0000-4000-a000-000000000003';
const sessionId = 'session-service-test';

const baseSessionRow = {
  sessionId,
  projectId,
  projectName: 'Project One',
  ownerId,
  status: 'running' as const,
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-01T11:00:00.000Z'),
};

beforeEach(() => {
  queryRecords = [];
  resultForQuery = () => [];
});

describe('listSessionCosts service', () => {
  test('paginates base sessions and attaches account-wide reconciliation', async () => {
    resultForQuery = (fields, table) => {
      if (table === projectSessions && 'projectName' in fields) return [baseSessionRow];
      if (table === projectSessions && 'total' in fields) return [{ total: 2 }];
      if (table === gatewayRequestLogs && 'llmCost' in fields) {
        return [
          {
            sessionId,
            llmCost: '1.25',
            requestCount: 3,
            errorCount: 1,
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 20,
            cacheWriteTokens: 5,
            modelCount: 2,
            lastAt: new Date('2026-07-01T11:30:00.000Z'),
          },
        ];
      }
      if (table === sandboxComputeSessions && 'computeCost' in fields) {
        return [
          {
            sessionId,
            computeCost: '0.75',
            computeSeconds: 120,
            lastAt: '2026-07-01T11:31:00.000Z',
          },
        ];
      }
      if (table === gatewayRequestLogs && 'requests' in fields && !('tokens' in fields)) {
        return [{ cost: '0.1', requests: 1 }];
      }
      if (table === sandboxComputeSessions && 'windows' in fields) {
        return [{ cost: '0.2', windows: 1, seconds: 30 }];
      }
      return [];
    };

    const result = await listSessionCosts({
      accountId,
      projectId,
      limit: 1,
      offset: 0,
    });

    expect(result).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      next_offset: 1,
      reconciliation: {
        llm_cost: 0.1,
        compute_cost: 0.2,
        total_cost: 0.3,
        request_count: 1,
        compute_window_count: 1,
        compute_seconds: 30,
      },
    });
    expect(result.sessions).toEqual([
      expect.objectContaining({
        session_id: sessionId,
        owner_type: 'user',
        owner_name: 'Owner One',
        llm_cost: 1.25,
        compute_cost: 0.75,
        total_cost: 2,
        last_activity_at: '2026-07-01T11:31:00.000Z',
      }),
    ]);

    const baseQuery = queryRecords.find(
      (query) => query.table === projectSessions && 'projectName' in query.fields,
    );
    expect(baseQuery?.calls.map((call) => call.method)).toEqual([
      'innerJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
    ]);
    expect(baseQuery?.calls.find((call) => call.method === 'limit')?.args).toEqual([1]);
    expect(baseQuery?.calls.find((call) => call.method === 'offset')?.args).toEqual([0]);
  });
});

describe('getSessionCostRecord service', () => {
  test('returns model usage and a mixed newest-first ledger', async () => {
    resultForQuery = (fields, table) => {
      if (table === projectSessions && 'projectName' in fields) return [baseSessionRow];
      if (table === gatewayRequestLogs && 'llmCost' in fields) {
        return [
          {
            sessionId,
            llmCost: '0.5',
            requestCount: 1,
            errorCount: 0,
            inputTokens: 10,
            outputTokens: 20,
            cachedTokens: 2,
            cacheWriteTokens: 1,
            modelCount: 1,
            lastAt: new Date('2026-07-01T11:03:00.000Z'),
          },
        ];
      }
      if (table === sandboxComputeSessions && 'computeCost' in fields) {
        return [
          {
            sessionId,
            computeCost: '0.25',
            computeSeconds: 120,
            lastAt: '2026-07-01T11:02:00.000Z',
          },
        ];
      }
      if (table === gatewayRequestLogs && 'requestCount' in fields && 'model' in fields) {
        return [
          {
            provider: 'bedrock',
            model: 'anthropic/claude-sonnet-5',
            requestCount: 1,
            errorCount: 0,
            inputTokens: 10,
            outputTokens: 20,
            cachedTokens: 2,
            cacheWriteTokens: 1,
            cost: '0.5',
            lastAt: new Date('2026-07-01T11:03:00.000Z'),
          },
        ];
      }
      if (table === gatewayRequestLogs && 'occurredAt' in fields) {
        return [
          {
            id: 'llm-entry',
            occurredAt: new Date('2026-07-01T11:03:00.000Z'),
            cost: '0.5',
            provider: 'bedrock',
            model: 'anthropic/claude-sonnet-5',
            requestId: 'request-one',
            status: 200,
            ok: true,
            inputTokens: 10,
            outputTokens: 20,
            cachedTokens: 2,
            cacheWriteTokens: 1,
          },
        ];
      }
      if (table === sandboxComputeSessions && 'startedAt' in fields) {
        return [
          {
            id: 'compute-entry',
            startedAt: '2026-07-01T11:00:00.000Z',
            endedAt: null,
            billedThroughAt: '2026-07-01T11:02:00.000Z',
            cost: '0.25',
            provider: 'daytona',
            state: 'active',
            cpuCores: 2,
            memoryGb: 4,
            diskGb: 20,
            gpuCount: 0,
          },
        ];
      }
      return [];
    };

    const detail = await getSessionCostRecord({ accountId, projectId, sessionId });

    expect(detail?.model_usage).toEqual([
      {
        provider: 'bedrock',
        model: 'anthropic/claude-sonnet-5',
        request_count: 1,
        error_count: 0,
        input_tokens: 10,
        output_tokens: 20,
        cached_tokens: 2,
        cache_write_tokens: 1,
        cost: 0.5,
        last_at: '2026-07-01T11:03:00.000Z',
      },
    ]);
    expect(detail?.ledger_entries.map((entry) => entry.id)).toEqual(['llm-entry', 'compute-entry']);
    expect(detail?.ledger_entries[1]).toMatchObject({
      kind: 'compute',
      compute_seconds: 120,
      billed_through_at: '2026-07-01T11:02:00.000Z',
    });
  });

  test('returns null when the account and project scoped base session is absent', async () => {
    resultForQuery = () => [];

    expect(await getSessionCostRecord({ accountId, projectId, sessionId })).toBeNull();
    expect(queryRecords).toHaveLength(1);
  });
});

describe('listProjectGatewaySessionSpend service', () => {
  test('keeps the existing window_days and sessions response', async () => {
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'tokens' in fields) {
        return [
          {
            sessionId,
            requests: 2,
            errors: 0,
            cost: '0.4',
            tokens: '50',
            models: 1,
            lastAt: new Date('2026-07-01T11:00:00.000Z'),
          },
        ];
      }
      if (table === sandboxComputeSessions && 'seconds' in fields) {
        return [
          {
            sessionId,
            cost: '0.6',
            seconds: 180,
            lastAt: '2026-07-01T11:01:00.000Z',
          },
        ];
      }
      return [];
    };

    expect(
      await listProjectGatewaySessionSpend({
        accountId,
        projectId,
        days: 45,
      }),
    ).toEqual({
      window_days: 45,
      sessions: [
        {
          session_id: sessionId,
          llm_cost: 0.4,
          compute_cost: 0.6,
          requests: 2,
          errors: 0,
          tokens: 50,
          models: 1,
          compute_seconds: 180,
          last_at: '2026-07-01T11:01:00.000Z',
          total_cost: 1,
        },
      ],
    });
  });
});
