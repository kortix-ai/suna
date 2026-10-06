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

// Renders the GROUP BY fragment so a test can pin which grouping sets one
// scan computes. Same reasoning as renderWhere: a recorded groupBy() call
// without rendered SQL proves nothing about what the statement does.
function renderGroupBy(record: QueryRecord | undefined): string {
  const terms = record?.calls.find((call) => call.method === 'groupBy')?.args;
  if (!terms?.length) throw new Error('query recorded no groupBy() call');
  const dialect = new PgDialect();
  return dialect.sqlToQuery(terms[0] as SQL).sql;
}

// Renders one selected field's SQL expression (e.g. a `sum(...)` aggregate)
// to text, so a test can pin the exact column a money or duration figure is
// computed from. Without this, swapping final_cost_precise for the
// legacy, lower-precision final_cost column — or swapping a billed-seconds
// expression for raw wall time — changes no assertion anywhere in this file.
function renderField(record: QueryRecord | undefined, key: string): string {
  const value = record?.fields[key];
  if (!value) throw new Error(`query recorded no "${key}" field`);
  return new PgDialect().sqlToQuery(value as SQL).sql;
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
  // getCostSummary imports billedComputeSecondsExpression from
  // session-costs.ts, which transitively imports projects/lib/access.ts ->
  // platform-roles.ts, which reads hasDatabase from this same module at
  // import time. Only the query-builder mock above matters to this file's
  // tests, but the module has to satisfy every export the import graph
  // touches or the import throws before any test runs.
  hasDatabase: true,
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
    llm_kortix_cost: 0,
    llm_provider_cost: 0,
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

/** Grouped-scan contract: one pass per source per window. */
describe('getCostSummary grouped scans', () => {
  const window = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-08T00:00:00.000Z'),
  };

  test('issues one scan per source per window — two gateway, two compute — not one query per figure', async () => {
    await getCostSummary({ accountId, window });

    // Prod Server-Timing (2026-10-04, the largest account): this route spent
    // db;dur=4.5–25s across n=10 statements, five of them independent scans
    // of the same 30-day gateway_request_logs window and four of
    // sandbox_compute_sessions. Every extra scan re-reads the same heap
    // pages, so the explorer's cold load timed out at the 25s cap. The
    // grouping-set collapse is the fix this suite pins: one scan per source
    // per window, plus one prior-window scan per source.
    expect(queryRecords.filter((query) => query.table === gatewayRequestLogs)).toHaveLength(2);
    expect(queryRecords.filter((query) => query.table === sandboxComputeSessions)).toHaveLength(2);
  });

  test('the current-window gateway scan computes totals, days, models and projects in one grouping-sets pass', async () => {
    await getCostSummary({ accountId, window });

    const scan = queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'setId' in query.fields,
    );
    const groupBy = renderGroupBy(scan);
    expect(groupBy).toContain('grouping sets');
    // The four views the summary serves, each its own set of one scan.
    expect(groupBy).toContain('"provider"');
    expect(groupBy).toContain('"resolved_model"');
    expect(groupBy).toContain("date_trunc('day'");
    expect(groupBy).toContain('"project_id"');
    // The grand total is the empty set, and every window bound is a plain
    // column comparison the account_time index serves.
    expect(groupBy).toContain('()');
    const where = renderWhere(scan);
    expect(where.sql).toContain('"created_at" >= $');
    expect(where.sql).toContain('"created_at" < $');
  });

  test('the current-window compute scan covers totals, days and projects through one left join', async () => {
    await getCostSummary({ accountId, window });

    const scan = queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'setId' in query.fields,
    );
    // LEFT JOIN, never INNER: the grand-total set must still cover compute
    // spend whose session has no project_sessions row (the account-wide
    // total includes unassigned spend), and a LEFT JOIN keeps every row.
    expect(scan?.calls.map((call) => call.method)).toEqual(['leftJoin', 'where', 'groupBy']);
    expect(renderJoinOn(scan, 'leftJoin')).toBe(
      '"kortix"."project_sessions"."session_id" = "kortix"."sandbox_compute_sessions"."session_id"',
    );
    const groupBy = renderGroupBy(scan);
    expect(groupBy).toContain('grouping sets');
    expect(groupBy).toContain("date_trunc('day'");
    expect(groupBy).toContain('"project_id"');
    expect(groupBy).toContain('()');
  });

  test('the setId marker is a grouping() case, not a data-shape guess', async () => {
    await getCostSummary({ accountId, window });

    const scan = queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'setId' in query.fields,
    );
    const setId = renderField(scan, 'setId');
    expect(setId).toContain('grouping(');
    expect(setId).toContain("'model'");
    expect(setId).toContain("'day'");
    expect(setId).toContain("'project'");
    expect(setId).toContain("'totals'");
  });
});

describe('getCostSummary', () => {
  const window = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-08T00:00:00.000Z'),
  };
  const projectId = '00000000-0000-4000-a000-000000000002';
  const sessionId = 'session-summary-test';

  // The two grouped scans each carry every field the summary needs; the two
  // prior-window scans each carry exactly one (`cost`). Dispatch on that.
  function llmGroupedRecord() {
    return queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'setId' in query.fields,
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
  function computeGroupedRecord() {
    return queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'setId' in query.fields,
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

    const llmWhere = renderWhere(llmGroupedRecord());
    expect(llmWhere.sql).toContain('"created_at" >= $');
    expect(llmWhere.sql).toContain('"created_at" < $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);

    const computeWhere = renderWhere(computeGroupedRecord());
    expect(computeWhere.sql).toContain('"started_at" >= $');
    expect(computeWhere.sql).toContain('"started_at" < $');
    expect(computeWhere.sql).not.toContain('last_billed_at');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
  });

  test('the compute scan left-joins project_sessions, so unassigned spend stays in the grand total', async () => {
    await getCostSummary({ accountId, window });

    // Joining project_sessions with an INNER join would inner-join away
    // compute cost from sessions with no project_sessions row, undercounting
    // the account-wide total that the "unassigned" row downstream depends
    // on. The LEFT JOIN keeps every row; the prior-window scan carries the
    // same rule (no join at all there), so `previous.total_cost` cannot
    // silently exclude unassigned compute either.
    expect(computeGroupedRecord()?.calls.map((call) => call.method)).toEqual([
      'leftJoin',
      'where',
      'groupBy',
    ]);
    expect(computePriorRecord()?.calls.map((call) => call.method)).toEqual(['where']);

    const llmWhere = renderWhere(llmGroupedRecord());
    expect(llmWhere.params).toHaveLength(3);
  });

  test('every money and duration figure is computed from the precise, unbilled-drift-free column', async () => {
    await getCostSummary({ accountId, window });

    // gateway_request_logs carries two cost columns: the legacy
    // final_cost (numeric(12,6)) and final_cost_precise (numeric(20,10),
    // Drizzle field name finalCost). Only the precise column may back any
    // of these LLM money aggregates — a swap to the legacy column
    // truncates money and nothing else here would notice.
    expect(renderField(llmGroupedRecord(), 'llmCost')).toContain('"final_cost_precise"');
    expect(renderField(llmGroupedRecord(), 'llmKortixCost')).toContain('"final_cost_precise"');
    expect(renderField(llmGroupedRecord(), 'llmProviderCost')).toContain(
      '"upstream_cost_precise"',
    );
    expect(renderField(llmPriorRecord(), 'cost')).toContain('"final_cost_precise"');

    // compute_seconds must be BILLED seconds (last_billed_at - started_at),
    // not raw wall time (e.g. now() - started_at, or ended_at - started_at)
    // — a session that stopped accruing charges but never formally ended
    // would otherwise keep accumulating seconds it was never billed for.
    const computeSecondsSql = renderField(computeGroupedRecord(), 'computeSeconds');
    expect(computeSecondsSql).toContain('"last_billed_at"');
    expect(computeSecondsSql).toContain('"started_at"');
  });

  test('scopes the project predicate into the WHERE of both grouped scans when provided', async () => {
    await getCostSummary({ accountId, projectId, window });

    const llmWhere = renderWhere(llmGroupedRecord());
    expect(llmWhere.sql).toContain('"project_id" = $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      projectId,
    ]);

    const computeRecord = computeGroupedRecord();
    // The predicate on the joined column makes the LEFT JOIN behave exactly
    // like the INNER JOIN an ungrouped version used: a right side that
    // fails the predicate drops the row, matched or not.
    expect(renderJoinOn(computeRecord, 'leftJoin')).toBe(
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

  test('scopes to session_id on both sources without needing the project predicate', async () => {
    await getCostSummary({ accountId, sessionId, window });

    const llmWhere = renderWhere(llmGroupedRecord());
    expect(llmWhere.sql).toContain('"session_id" = $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      sessionId,
    ]);

    const computeWhere = renderWhere(computeGroupedRecord());
    expect(computeWhere.sql).toContain('"session_id" = $');
    expect(computeWhere.sql).not.toContain('"project_sessions"."project_id" = $');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      sessionId,
    ]);
  });

  test('the model breakdown orders by spend descending with a deterministic tie-break, top 10', async () => {
    // Rows arrive in whatever order the scan returns; a cost tie straddling
    // the 10th row exercises both the ordering and the LIMIT 10.
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'setId' in fields) {
        const model = (provider: string, model: string, cost: number, requestCount: number) => ({
          setId: 'model',
          provider,
          model,
          day: null,
          projectId: null,
          llmCost: cost,
          llmKortixCost: cost,
          llmProviderCost: 0,
          requestCount,
          sessionCount: 1,
        });
        return [
          model('zeta', 'm-1', 1, 1),
          model('alpha', 'm-9', 9, 1),
          ...Array.from({ length: 8 }, (_, index) =>
            model('bedrock', `anthropic/claude-${index}`, 5, 1),
          ),
          // The cost-5 tie runs past the 10th row: without a deterministic
          // break, which model lands there can flip between refreshes.
          model('anthropic', 'claude-a', 5, 1),
          model('anthropic', 'claude-b', 5, 1),
          model('anthropic', 'claude-c', 5, 1),
          model('anthropic', 'claude-d', 5, 1),
        ];
      }
      return [];
    };

    const summary = await getCostSummary({ accountId, window });

    expect(summary.models).toHaveLength(10);
    // Most spend first.
    expect(summary.models[0]).toEqual({
      provider: 'alpha',
      model: 'm-9',
      cost: 9,
      request_count: 1,
    });
    // The spend-tie block: 'bedrock' outranks 'anthropic' at equal cost
    // (descending), the model descends inside a provider, and the cut at
    // ten keeps claude-d (the tie's 10th row) and drops claude-c onward.
    expect(summary.models[1]).toMatchObject({ provider: 'bedrock', model: 'anthropic/claude-7' });
    expect(summary.models[8]).toMatchObject({ provider: 'bedrock', model: 'anthropic/claude-0' });
    expect(summary.models[9]).toMatchObject({ provider: 'anthropic', model: 'claude-d' });
    expect(summary.models.map((row) => row.provider)).not.toContain('zeta');
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

  test('the project-scoped compute prior scan joins project_sessions before filtering on its column', async () => {
    // computeScope carries `project_sessions.project_id = $4` whenever a
    // project scope is set. A prior-window scan that filters on that column
    // without joining the table is invalid SQL (missing FROM-clause entry)
    // — the query double records calls without executing them, so only an
    // explicit join assertion catches it here. Postgres rejects it at
    // runtime; scripts/verify-cost-queries.ts executes the same paths.
    await getCostSummary({ accountId, projectId, window });

    const record = computePriorRecord();
    expect(record?.calls.map((call) => call.method)).toEqual(['innerJoin', 'where']);
    expect(renderJoinOn(record, 'innerJoin')).toBe(
      '"kortix"."project_sessions"."session_id" = "kortix"."sandbox_compute_sessions"."session_id"',
    );
    expect(renderWhere(record).sql).toContain('"project_sessions"."project_id" = $');
  });

  test('assembles totals, previous, series and models from the grouped scans', async () => {
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'setId' in fields) {
        return [
          {
            setId: 'totals',
            provider: null,
            model: null,
            day: null,
            projectId: null,
            llmCost: '10',
            llmKortixCost: '10',
            llmProviderCost: '0',
            requestCount: 4,
            sessionCount: 2,
          },
          {
            setId: 'day',
            provider: null,
            model: null,
            day: '2026-07-02',
            projectId: null,
            llmCost: '10',
            llmKortixCost: '10',
            llmProviderCost: '0',
            requestCount: 4,
            sessionCount: 1,
          },
          {
            setId: 'model',
            provider: 'bedrock',
            model: 'anthropic/claude-sonnet-5',
            day: null,
            projectId: null,
            llmCost: '10',
            llmKortixCost: '10',
            llmProviderCost: '0',
            requestCount: 4,
            sessionCount: 1,
          },
          {
            setId: 'project',
            provider: null,
            model: null,
            day: null,
            projectId: 'p1',
            llmCost: '10',
            llmKortixCost: '10',
            llmProviderCost: '0',
            requestCount: 4,
            sessionCount: 1,
          },
        ];
      }
      if (table === gatewayRequestLogs) return [{ cost: '4' }];
      if (table === sandboxComputeSessions && 'setId' in fields) {
        return [
          {
            setId: 'totals',
            day: null,
            projectId: null,
            computeCost: '5',
            computeSeconds: 900,
            sessionCount: 3,
          },
          {
            setId: 'day',
            day: '2026-07-03',
            projectId: null,
            computeCost: '5',
            computeSeconds: 900,
            sessionCount: 1,
          },
          // p1 again (both sources touch it) plus p2, which has ONLY
          // compute spend in this window and zero gateway_request_logs
          // rows — the scenario a count(distinct) on the LLM side alone
          // would miss.
          { setId: 'project', day: null, projectId: 'p1', computeCost: '5', computeSeconds: 900, sessionCount: 1 },
          { setId: 'project', day: null, projectId: 'p2', computeCost: '5', computeSeconds: 900, sessionCount: 1 },
        ];
      }
      if (table === sandboxComputeSessions) return [{ cost: '6' }];
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
      llm_kortix_cost: 10,
      llm_provider_cost: 0,
      compute_cost: 5,
      total_cost: 15,
      request_count: 4,
      compute_seconds: 900,
      // The larger of the two sources' distinct session counts.
      session_count: 3,
      // The union of {p1} (LLM) and {p1, p2} (compute) is {p1, p2}: 2, not
      // the 1 that counting only the LLM side's distinct project_id would
      // give.
      project_count: 2,
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

  test('drops the LEFT JOIN\'s NULL project group and counts a compute-only project', async () => {
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'setId' in fields) {
        // An account-wide window whose only project-set rows come from the
        // compute side; the LLM side still returns its totals row.
        return [
          {
            setId: 'totals',
            provider: null,
            model: null,
            day: null,
            projectId: null,
            llmCost: '0',
            llmKortixCost: '0',
            llmProviderCost: '0',
            requestCount: 0,
            sessionCount: 0,
          },
        ];
      }
      if (table === sandboxComputeSessions && 'setId' in fields) {
        return [
          {
            setId: 'totals',
            day: null,
            projectId: null,
            computeCost: '5',
            computeSeconds: 900,
            sessionCount: 3,
          },
          // Unassigned compute spend: the LEFT JOIN's NULL project group.
          // It must be dropped from the distinct-project count (it has no
          // project) while its cost stays in the grand-total set.
          { setId: 'project', day: null, projectId: null, computeCost: '2', computeSeconds: 60, sessionCount: 1 },
          { setId: 'project', day: null, projectId: 'compute-only-project', computeCost: '3', computeSeconds: 840, sessionCount: 2 },
        ];
      }
      return [];
    };

    const summary = await getCostSummary({ accountId, window });

    expect(summary.totals.project_count).toBe(1);
    // Unassigned compute is still part of the account-wide total.
    expect(summary.totals.compute_cost).toBe(5);
  });

  test('an empty window still yields one totals row per source and a zero-filled series', async () => {
    resultForQuery = (fields, table) => {
      if (table === gatewayRequestLogs && 'setId' in fields) {
        // Each grand-total set returns its single all-NULL row even on an
        // empty window; every grouped set returns none.
        return [
          {
            setId: 'totals',
            provider: null,
            model: null,
            day: null,
            projectId: null,
            llmCost: '0',
            llmKortixCost: '0',
            llmProviderCost: '0',
            requestCount: 0,
            sessionCount: 0,
          },
        ];
      }
      if (table === sandboxComputeSessions && 'setId' in fields) {
        return [
          { setId: 'totals', day: null, projectId: null, computeCost: '0', computeSeconds: 0, sessionCount: 0 },
        ];
      }
      return [];
    };

    const summary = await getCostSummary({
      accountId,
      window: {
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
    });

    expect(summary.totals.total_cost).toBe(0);
    expect(summary.previous).toEqual({ total_cost: 0 });
    expect(summary.series).toEqual([
      { day: '2026-07-01', llm_cost: 0, compute_cost: 0, total_cost: 0 },
      { day: '2026-07-02', llm_cost: 0, compute_cost: 0, total_cost: 0 },
    ]);
    expect(summary.models).toEqual([]);
  });
});
