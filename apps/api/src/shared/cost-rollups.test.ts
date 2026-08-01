import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ProjectCostRow } from './cost-rollups';
import type { CostSort } from './cost-window';

type QueryRecord = {
  fields: Record<string, unknown>;
  table: unknown;
  calls: Array<{ method: string; args: unknown[] }>;
};

let queryRecords: QueryRecord[] = [];
let resultForQuery: (fields: Record<string, unknown>, table: unknown) => unknown[] = () => [];

// The mock never talks to Postgres, so render the recorded WHERE/JOIN clauses
// to real SQL to assert which columns and bounds a query actually carries.
// Recording calls without rendering them would let a test assert "a query was
// built" while proving nothing about what it does.
function renderWhere(record: QueryRecord | undefined): { sql: string; params: unknown[] } {
  const where = record?.calls.find((call) => call.method === 'where')?.args[0];
  if (!where) throw new Error('query recorded no where() call');
  return new PgDialect().sqlToQuery(where as SQL);
}

function renderJoinOn(record: QueryRecord | undefined, method: 'innerJoin' | 'leftJoin'): string {
  const call = record?.calls.find((c) => c.method === method);
  if (!call) throw new Error(`query recorded no ${method}() call`);
  return new PgDialect().sqlToQuery(call.args[1] as SQL).sql;
}

// The mock records orderBy() without applying it, so the ORDER BY can only be
// asserted by rendering it, same reasoning as renderWhere above.
function renderOrderBy(record: QueryRecord | undefined): string[] {
  const terms = record?.calls.find((call) => call.method === 'orderBy')?.args;
  if (!terms?.length) throw new Error('query recorded no orderBy() call');
  const dialect = new PgDialect();
  return terms.map((term) => dialect.sqlToQuery(term as SQL).sql);
}

function createQueryBuilder(record: QueryRecord, rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
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

const {
  buildCostSeries,
  getCostSummary,
  listCostByProject,
  mergeProjectCostRows,
  previousWindow,
  sortProjectRows,
} = await import('./cost-rollups');

const accountId = '00000000-0000-4000-a000-000000000001';

const names = new Map([
  ['p1', 'veyris-family-office'],
  ['p2', 'Main'],
]);

beforeEach(() => {
  queryRecords = [];
  resultForQuery = () => [];
});

describe('mergeProjectCostRows', () => {
  test('sums llm and compute into one row per project', () => {
    const rows = mergeProjectCostRows(
      [{ projectId: 'p1', llmCost: 12.4, sessionCount: 41, lastAt: '2026-07-31T00:00:00.000Z' }],
      [
        {
          projectId: 'p1',
          computeCost: 34.02,
          sessionCount: 41,
          lastAt: '2026-07-31T05:00:00.000Z',
        },
      ],
      names,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: 'p1',
      project_name: 'veyris-family-office',
      llm_cost: 12.4,
      compute_cost: 34.02,
      total_cost: 46.42,
      last_activity_at: '2026-07-31T05:00:00.000Z',
    });
  });

  test('includes a project that has compute cost but no llm cost', () => {
    const rows = mergeProjectCostRows(
      [],
      [
        {
          projectId: 'p2',
          computeCost: 2.14,
          sessionCount: 18,
          lastAt: '2026-07-29T00:00:00.000Z',
        },
      ],
      names,
    );
    expect(rows[0]).toMatchObject({ project_id: 'p2', llm_cost: 0, compute_cost: 2.14 });
  });

  test('falls back to the project id when the name is unknown', () => {
    const rows = mergeProjectCostRows(
      [{ projectId: 'p9', llmCost: 1, sessionCount: 1, lastAt: null }],
      [],
      names,
    );
    expect(rows[0].project_name).toBe('p9');
  });

  test('takes the larger session count across both sources', () => {
    const rows = mergeProjectCostRows(
      [{ projectId: 'p1', llmCost: 1, sessionCount: 3, lastAt: null }],
      [{ projectId: 'p1', computeCost: 1, sessionCount: 7, lastAt: null }],
      names,
    );
    expect(rows[0].session_count).toBe(7);
  });

  test('ignores a row with no project id instead of grouping it under "null"', () => {
    const rows = mergeProjectCostRows(
      [{ projectId: null, llmCost: 99, sessionCount: 5, lastAt: null }],
      [],
      names,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('sortProjectRows', () => {
  const baseRow: ProjectCostRow = {
    project_id: 'p1',
    project_name: 'Alpha',
    session_count: 1,
    llm_cost: 0,
    compute_cost: 0,
    total_cost: 0,
    last_activity_at: null,
  };
  const row = (overrides: Partial<ProjectCostRow>): ProjectCostRow => ({
    ...baseRow,
    ...overrides,
  });

  test('total_desc ranks the most expensive project first', () => {
    const rows = [
      row({ project_id: 'p1', total_cost: 1 }),
      row({ project_id: 'p2', total_cost: 5 }),
    ];
    expect(sortProjectRows(rows, 'total_desc').map((r) => r.project_id)).toEqual(['p2', 'p1']);
  });

  test('total_asc ranks the cheapest project first', () => {
    const rows = [
      row({ project_id: 'p1', total_cost: 1 }),
      row({ project_id: 'p2', total_cost: 5 }),
    ];
    expect(sortProjectRows(rows, 'total_asc').map((r) => r.project_id)).toEqual(['p1', 'p2']);
  });

  test('recent ranks the most recently active project first', () => {
    const rows = [
      row({ project_id: 'p1', last_activity_at: '2026-07-01T00:00:00.000Z' }),
      row({ project_id: 'p2', last_activity_at: '2026-07-05T00:00:00.000Z' }),
    ];
    expect(sortProjectRows(rows, 'recent').map((r) => r.project_id)).toEqual(['p2', 'p1']);
  });

  test('name_asc ranks alphabetically by project name', () => {
    const rows = [
      row({ project_id: 'p1', project_name: 'Zeta' }),
      row({ project_id: 'p2', project_name: 'Alpha' }),
    ];
    expect(sortProjectRows(rows, 'name_asc').map((r) => r.project_id)).toEqual(['p2', 'p1']);
  });

  test('every sort breaks ties on project_id ascending, never leaving order unstable', () => {
    const sorts: CostSort[] = ['total_desc', 'total_asc', 'recent', 'name_asc'];
    for (const sort of sorts) {
      const tied = [
        row({ project_id: 'zz', project_name: 'Same', total_cost: 1, last_activity_at: null }),
        row({ project_id: 'aa', project_name: 'Same', total_cost: 1, last_activity_at: null }),
      ];
      expect(sortProjectRows(tied, sort).map((r) => r.project_id)).toEqual(['aa', 'zz']);
    }
  });

  test('does not mutate the input array', () => {
    const rows = [
      row({ project_id: 'p1', total_cost: 1 }),
      row({ project_id: 'p2', total_cost: 5 }),
    ];
    const original = [...rows];
    sortProjectRows(rows, 'total_desc');
    expect(rows).toEqual(original);
  });
});

describe('listCostByProject', () => {
  const costWindow = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-08T00:00:00.000Z'),
  };

  test('windows the LLM aggregate on created_at and the compute aggregate on started_at', async () => {
    await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const llmAggregate = queryRecords.find((query) => query.table === gatewayRequestLogs);
    const computeAggregate = queryRecords.find((query) => query.table === sandboxComputeSessions);

    // Half-open [from, to) on the columns idx_gateway_logs_account_time and
    // idx_sandbox_compute_sessions_account_time cover.
    const llmWhere = renderWhere(llmAggregate);
    expect(llmWhere.sql).toContain('"created_at" >= $');
    expect(llmWhere.sql).toContain('"created_at" < $');
    expect(llmWhere.sql).toContain('"project_id" is not null');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);

    const computeWhere = renderWhere(computeAggregate);
    expect(computeWhere.sql).toContain('"started_at" >= $');
    expect(computeWhere.sql).toContain('"started_at" < $');
    // last_billed_at's only index is partial (WHERE state = 'active'), built
    // for the biller — it must never become the window column here.
    expect(computeWhere.sql).not.toContain('last_billed_at');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
  });

  test('reaches project_id through the project_sessions primary key, not a scan', async () => {
    await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const computeAggregate = queryRecords.find((query) => query.table === sandboxComputeSessions);
    expect(computeAggregate?.calls.map((call) => call.method)).toEqual([
      'innerJoin',
      'where',
      'groupBy',
    ]);
    expect(renderJoinOn(computeAggregate, 'innerJoin')).toBe(
      '"kortix"."project_sessions"."session_id" = "kortix"."sandbox_compute_sessions"."session_id"',
    );
    expect(computeAggregate?.calls.find((call) => call.method === 'groupBy')?.args).toEqual([
      projectSessions.projectId,
    ]);
  });

  test('scopes the project name lookup to the account', async () => {
    await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const projectsQuery = queryRecords.find((query) => query.table === projects);
    const where = renderWhere(projectsQuery);
    expect(where.sql).toBe('"kortix"."projects"."account_id" = $1');
    expect(where.params).toEqual([accountId]);
  });

  test('merges, sorts, and pages the three windowed queries into one response', async () => {
    resultForQuery = (_fields, table) => {
      if (table === gatewayRequestLogs) {
        return [
          {
            projectId: 'p1',
            llmCost: '1',
            sessionCount: 2,
            lastAt: new Date('2026-07-02T00:00:00.000Z'),
          },
          {
            projectId: 'p2',
            llmCost: '5',
            sessionCount: 1,
            lastAt: new Date('2026-07-03T00:00:00.000Z'),
          },
        ];
      }
      if (table === sandboxComputeSessions) {
        return [
          {
            projectId: 'p1',
            computeCost: '2',
            sessionCount: 2,
            lastAt: '2026-07-02T01:00:00.000Z',
          },
        ];
      }
      if (table === projects) {
        return [
          { projectId: 'p1', name: 'Alpha' },
          { projectId: 'p2', name: 'Beta' },
        ];
      }
      return [];
    };

    const firstPage = await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 1,
      offset: 0,
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.limit).toBe(1);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.next_offset).toBe(1);
    expect(firstPage.projects).toEqual([
      expect.objectContaining({ project_id: 'p2', project_name: 'Beta', total_cost: 5 }),
    ]);

    const secondPage = await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 1,
      offset: 1,
    });
    expect(secondPage.next_offset).toBeNull();
    expect(secondPage.projects).toEqual([
      expect.objectContaining({ project_id: 'p1', project_name: 'Alpha', total_cost: 3 }),
    ]);
  });

  test('returns an empty page with total 0 and a null next_offset when nothing matches', async () => {
    resultForQuery = () => [];
    const page = await listCostByProject({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });
    expect(page).toEqual({ projects: [], total: 0, limit: 25, offset: 0, next_offset: null });
  });
});

describe('previousWindow', () => {
  test('returns the equally long window immediately before', () => {
    const previous = previousWindow({
      from: new Date('2026-07-02T00:00:00.000Z'),
      to: new Date('2026-07-09T00:00:00.000Z'),
    });
    expect(previous.from.toISOString()).toBe('2026-06-25T00:00:00.000Z');
    expect(previous.to.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  test('crosses a month boundary correctly', () => {
    const previous = previousWindow({
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-04T00:00:00.000Z'),
    });
    expect(previous.from.toISOString()).toBe('2026-06-28T00:00:00.000Z');
    expect(previous.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('handles a single-day window', () => {
    const previous = previousWindow({
      from: new Date('2026-07-02T00:00:00.000Z'),
      to: new Date('2026-07-03T00:00:00.000Z'),
    });
    expect(previous.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(previous.to.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('buildCostSeries', () => {
  const window = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-04T00:00:00.000Z'),
  };

  test('emits one point per UTC day in the window', () => {
    const series = buildCostSeries([], [], window);
    expect(series.map((point) => point.day)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  test('fills days with no spend as zero rather than omitting them', () => {
    const series = buildCostSeries([{ day: '2026-07-02', cost: 5 }], [], window);
    expect(series[0]).toMatchObject({ day: '2026-07-01', total_cost: 0 });
    expect(series[1]).toMatchObject({ day: '2026-07-02', llm_cost: 5, total_cost: 5 });
    expect(series[2]).toMatchObject({ day: '2026-07-03', total_cost: 0 });
  });

  test('sums llm and compute on the same day', () => {
    const series = buildCostSeries(
      [{ day: '2026-07-03', cost: 2 }],
      [{ day: '2026-07-03', cost: 3 }],
      window,
    );
    expect(series[2]).toMatchObject({ llm_cost: 2, compute_cost: 3, total_cost: 5 });
  });

  test('emits exactly one point for a single-day window', () => {
    const series = buildCostSeries([], [], {
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-02T00:00:00.000Z'),
    });
    expect(series).toEqual([{ day: '2026-07-01', llm_cost: 0, compute_cost: 0, total_cost: 0 }]);
  });

  test('crosses a month boundary, keeping each day in its own UTC bucket', () => {
    const series = buildCostSeries(
      [{ day: '2026-07-31', cost: 1 }],
      [{ day: '2026-08-01', cost: 2 }],
      { from: new Date('2026-07-30T00:00:00.000Z'), to: new Date('2026-08-02T00:00:00.000Z') },
    );
    expect(series.map((point) => point.day)).toEqual(['2026-07-30', '2026-07-31', '2026-08-01']);
    expect(series[1]).toMatchObject({ llm_cost: 1, total_cost: 1 });
    expect(series[2]).toMatchObject({ compute_cost: 2, total_cost: 2 });
  });
});

describe('getCostSummary', () => {
  const window = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-08T00:00:00.000Z'),
  };
  const projectId = '00000000-0000-4000-a000-000000000002';
  const sessionId = 'session-summary-test';

  function llmTotalsRecord() {
    return queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'llmCost' in query.fields,
    );
  }
  function llmDailyRecord() {
    return queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'day' in query.fields,
    );
  }
  function modelsRecord() {
    return queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'model' in query.fields,
    );
  }
  function llmPriorRecord() {
    return queryRecords.find(
      (query) =>
        query.table === gatewayRequestLogs &&
        Object.keys(query.fields).length === 1 &&
        'cost' in query.fields,
    );
  }
  function computeTotalsRecord() {
    return queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'computeCost' in query.fields,
    );
  }
  function computeDailyRecord() {
    return queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'day' in query.fields,
    );
  }
  function computePriorRecord() {
    return queryRecords.find(
      (query) =>
        query.table === sandboxComputeSessions &&
        Object.keys(query.fields).length === 1 &&
        'cost' in query.fields,
    );
  }

  test('windows the LLM aggregate on created_at and the compute aggregate on started_at, never last_billed_at', async () => {
    await getCostSummary({ accountId, window });

    const llmWhere = renderWhere(llmTotalsRecord());
    expect(llmWhere.sql).toContain('"created_at" >= $');
    expect(llmWhere.sql).toContain('"created_at" < $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);

    const computeWhere = renderWhere(computeTotalsRecord());
    expect(computeWhere.sql).toContain('"started_at" >= $');
    expect(computeWhere.sql).toContain('"started_at" < $');
    expect(computeWhere.sql).not.toContain('last_billed_at');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
  });

  test('omits the project scope when unscoped, so compute totals cover unassigned spend too', async () => {
    await getCostSummary({ accountId, window });

    // Joining project_sessions unconditionally would inner-join away compute
    // cost from sessions with no project_sessions row, undercounting the
    // account-wide total that the "unassigned" row downstream depends on.
    expect(computeTotalsRecord()?.calls.map((call) => call.method)).not.toContain('innerJoin');
    expect(computeDailyRecord()?.calls.map((call) => call.method)).not.toContain('innerJoin');

    const llmWhere = renderWhere(llmTotalsRecord());
    expect(llmWhere.params).toHaveLength(3);
  });

  test('scopes every query to project_id when provided, joining compute through project_sessions', async () => {
    await getCostSummary({ accountId, projectId, window });

    const llmWhere = renderWhere(llmTotalsRecord());
    expect(llmWhere.sql).toContain('"project_id" = $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      projectId,
    ]);

    const computeRecord = computeTotalsRecord();
    expect(computeRecord?.calls.map((call) => call.method)).toContain('innerJoin');
    expect(renderJoinOn(computeRecord, 'innerJoin')).toBe(
      '"kortix"."project_sessions"."session_id" = "kortix"."sandbox_compute_sessions"."session_id"',
    );
    const computeWhere = renderWhere(computeRecord);
    expect(computeWhere.sql).toContain('"project_sessions"."project_id" = $');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      projectId,
    ]);
  });

  test('scopes to session_id on both sources without requiring a project_sessions join', async () => {
    await getCostSummary({ accountId, sessionId, window });

    const llmWhere = renderWhere(llmTotalsRecord());
    expect(llmWhere.sql).toContain('"session_id" = $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      sessionId,
    ]);

    const computeRecord = computeTotalsRecord();
    expect(computeRecord?.calls.map((call) => call.method)).not.toContain('innerJoin');
    const computeWhere = renderWhere(computeRecord);
    expect(computeWhere.sql).toContain('"session_id" = $');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      sessionId,
    ]);
  });

  test('the daily series is grouped and windowed the same as the totals', async () => {
    await getCostSummary({ accountId, window });

    expect(llmDailyRecord()?.calls.map((call) => call.method)).toEqual(['where', 'groupBy']);
    expect(renderWhere(llmDailyRecord()).params).toEqual(renderWhere(llmTotalsRecord()).params);

    expect(computeDailyRecord()?.calls.map((call) => call.method)).toEqual(['where', 'groupBy']);
    expect(renderWhere(computeDailyRecord()).params).toEqual(
      renderWhere(computeTotalsRecord()).params,
    );
  });

  test('the model breakdown groups by provider and model, ordered by spend descending, limited to 10', async () => {
    await getCostSummary({ accountId, window });

    const record = modelsRecord();
    expect(record?.calls.map((call) => call.method)).toEqual([
      'where',
      'groupBy',
      'orderBy',
      'limit',
    ]);
    expect(record?.calls.find((call) => call.method === 'groupBy')?.args).toEqual([
      gatewayRequestLogs.provider,
      gatewayRequestLogs.resolvedModel,
    ]);
    expect(renderOrderBy(record)[0]).toBe(
      'sum("kortix"."gateway_request_logs"."final_cost_precise") desc',
    );
    expect(record?.calls.find((call) => call.method === 'limit')?.args).toEqual([10]);
  });

  test('the prior window is the equal-length window immediately before the current one', async () => {
    await getCostSummary({ accountId, window });

    const expectedPrevious = previousWindow(window);
    expect(renderWhere(llmPriorRecord()).params).toEqual([
      accountId,
      expectedPrevious.from.toISOString(),
      expectedPrevious.to.toISOString(),
    ]);
    expect(renderWhere(computePriorRecord()).params).toEqual([
      accountId,
      expectedPrevious.from.toISOString(),
      expectedPrevious.to.toISOString(),
    ]);
  });

  test('assembles totals, previous, series and models from the aggregate queries', async () => {
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'llmCost' in fields) {
        return [{ llmCost: '10', requestCount: 4, sessionCount: 2, projectCount: 1 }];
      }
      if (table === gatewayRequestLogs && 'day' in fields) {
        return [{ day: '2026-07-02', cost: '10' }];
      }
      if (table === gatewayRequestLogs && 'model' in fields) {
        return [
          { provider: 'bedrock', model: 'anthropic/claude-sonnet-5', cost: '10', requestCount: 4 },
        ];
      }
      if (table === gatewayRequestLogs && Object.keys(fields).length === 1 && 'cost' in fields) {
        return [{ cost: '4' }];
      }
      if (table === sandboxComputeSessions && 'computeCost' in fields) {
        return [{ computeCost: '5', computeSeconds: 900, sessionCount: 3 }];
      }
      if (table === sandboxComputeSessions && 'day' in fields) {
        return [{ day: '2026-07-03', cost: '5' }];
      }
      if (
        table === sandboxComputeSessions &&
        Object.keys(fields).length === 1 &&
        'cost' in fields
      ) {
        return [{ cost: '6' }];
      }
      return [];
    };

    const summary = await getCostSummary({
      accountId,
      window: {
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-04T00:00:00.000Z'),
      },
    });

    expect(summary.totals).toEqual({
      llm_cost: 10,
      compute_cost: 5,
      total_cost: 15,
      request_count: 4,
      compute_seconds: 900,
      // The larger of the two sources' distinct session counts.
      session_count: 3,
      project_count: 1,
    });
    // 4 (llm prior) + 6 (compute prior).
    expect(summary.previous).toEqual({ total_cost: 10 });
    expect(summary.series).toEqual([
      { day: '2026-07-01', llm_cost: 0, compute_cost: 0, total_cost: 0 },
      { day: '2026-07-02', llm_cost: 10, compute_cost: 0, total_cost: 10 },
      { day: '2026-07-03', llm_cost: 0, compute_cost: 5, total_cost: 5 },
    ]);
    expect(summary.models).toEqual([
      { provider: 'bedrock', model: 'anthropic/claude-sonnet-5', cost: 10, request_count: 4 },
    ]);
  });
});
