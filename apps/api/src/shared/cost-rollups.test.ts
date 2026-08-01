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

function createQueryBuilder(record: QueryRecord, rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['innerJoin', 'leftJoin', 'where', 'groupBy']) {
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

const { listCostByProject, mergeProjectCostRows, sortProjectRows } = await import('./cost-rollups');

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
