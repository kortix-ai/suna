import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayRequestLogs, projectSessions, sandboxComputeSessions } from '@kortix/db';
import { Column, SQL, type SQLWrapper, Table, getTableColumns, is, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { CostSort } from './cost-window';

type QueryRecord = {
  fields: Record<string, unknown>;
  table: unknown;
  calls: Array<{ method: string; args: unknown[] }>;
};

let queryRecords: QueryRecord[] = [];
let resultForQuery: (fields: Record<string, unknown>, table: unknown) => unknown[] = () => [];

// The mock never talks to Postgres, so render the recorded WHERE clause to real
// SQL to assert which columns and bounds a query actually carries.
function renderWhere(record: QueryRecord | undefined): { sql: string; params: unknown[] } {
  const where = record?.calls.find((call) => call.method === 'where')?.args[0];
  if (!where) throw new Error('query recorded no where() call');
  return new PgDialect().sqlToQuery(where as SQL);
}

// The mock records orderBy() without applying it, so the ORDER BY can only be
// asserted by rendering it. Without this the sort direction and target column
// have no coverage at all.
function renderOrderBy(record: QueryRecord | undefined): string[] {
  const terms = record?.calls.find((call) => call.method === 'orderBy')?.args;
  if (!terms?.length) throw new Error('query recorded no orderBy() call');
  const dialect = new PgDialect();
  return terms.map((term) => dialect.sqlToQuery(term as SQL).sql);
}

// The paginated session page, which is the only query here that joins subqueries.
function requireBaseSessionQuery(): QueryRecord {
  const record = queryRecords.find(
    (query) => query.table === projectSessions && 'projectName' in query.fields,
  );
  if (!record) throw new Error('the joined session query was not recorded');
  return record;
}

// Drizzle renders a SQL-aliased subquery field UNQUALIFIED, so each one resolves
// against the OUTER query's FROM clause rather than against its own subquery.
// Collect exactly those bare identifiers, unquoted, off a recorded select list.
function unqualifiedSelectIdentifiers(record: QueryRecord): string[] {
  const dialect = new PgDialect();
  return Object.values(record.fields)
    .map((field) => dialect.sqlToQuery(sql`${field as SQLWrapper}`).sql)
    .filter((rendered) => /^"[^".]+"$/.test(rendered))
    .map((rendered) => rendered.slice(1, -1));
}

// What one FROM item makes available to an unqualified reference.
function exposedNames(item: unknown): string[] {
  // A real table exposes its columns under their SQL names. Derived through
  // getTableColumns, never hand-listed, so this cannot rot when a column is added
  // or renamed — that staleness is the same class this test exists to catch.
  if (is(item, Table)) return Object.values(getTableColumns(item)).map((column) => column.name);
  // A joined subquery arrives as the plain object the `.as()` double returns. Its
  // output name is the trailing segment of each field's rendered SQL: an aliased
  // expression renders bare (`"llm_cost"`), a passed-through column renders
  // qualified (`"llm_agg"."session_id"`), and both expose that last name. Every
  // field counts, including ones the outer query never selects outward.
  if (!item || typeof item !== 'object') return [];
  const dialect = new PgDialect();
  return Object.values(item as Record<string, unknown>).map((field) => {
    const rendered = dialect.sqlToQuery(sql`${field as SQLWrapper}`).sql;
    return rendered.slice(rendered.lastIndexOf('.') + 1).replaceAll('"', '');
  });
}

// Every name the outer FROM clause exposes, counted by how many FROM items expose
// it. This is Postgres's own resolution rule: an unqualified reference is matched
// against all FROM items at once, so a name exposed by two or more of them is
// ambiguous (42702) the moment anything references it. Modelling the rule rather
// than its symptoms covers all three ways this feature has hit it — two subqueries
// sharing an alias, an alias shadowing a real column, and an alias colliding with
// a sibling subquery's field.
function outerFromExposureCounts(record: QueryRecord): Map<string, number> {
  const joined = record.calls
    .filter((call) => call.method === 'innerJoin' || call.method === 'leftJoin')
    .map((call) => call.args[0]);

  const counts = new Map<string, number>();
  for (const item of [record.table, ...joined]) {
    // Per item, not per occurrence: the count must be "how many FROM items expose
    // this name", which is what decides ambiguity.
    for (const name of new Set(exposedNames(item))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

const SESSION_ID_TIEBREAK = '"kortix"."project_sessions"."session_id" asc';

// How Drizzle actually renders one field of a `.as(alias)` subquery. The two
// kinds render differently, and the difference is the whole point:
//   - a plain column     -> QUALIFIED,   `"llm_agg"."session_id"`
//   - a sql`...`.as('x') -> UNQUALIFIED, a bare `"x"`
// Measured against drizzle-orm 0.45.2, not assumed. An unqualified field is
// resolved against the outer FROM clause, so two subqueries that reuse an alias
// make the outer select ambiguous (Postgres 42702) instead of merely oddly
// named. A double that qualifies every field cannot express that failure.
function renderSubqueryField(alias: string, key: string, field: unknown): SQL {
  // Drizzle keeps the string passed to `.as('...')` on SQL.Aliased.fieldAlias.
  // Reading the JS key instead would hide a wrong alias as well as a colliding one.
  if (is(field, SQL.Aliased)) return sql.raw(`"${field.fieldAlias}"`);
  if (is(field, Column)) return sql.raw(`"${alias}"."${field.name}"`);
  // Neither an aliased expression nor a column, so no alias string exists to
  // read: fall back to the JS key. No query in this file takes this path today.
  return sql.raw(`"${alias}"."${key}"`);
}

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
  // Mirrors Drizzle's subquery terminator: `.as(alias)` ends the builder chain
  // and yields an object still keyed by the JS field names the caller selected,
  // each holding the SQL the outer query will render for it.
  builder.as = (alias: string) => {
    record.calls.push({ method: 'as', args: [alias] });
    return Object.fromEntries(
      Object.entries(record.fields).map(([key, field]) => [
        key,
        renderSubqueryField(alias, key, field),
      ]),
    );
  };
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

// listSessionCosts now reads the aggregates off the joined session row instead
// of a second round trip, so the fixture carries the left-joined columns.
const joinedSessionRow = {
  ...baseSessionRow,
  llmCost: '1.25',
  requestCount: 3,
  errorCount: 1,
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: 20,
  cacheWriteTokens: 5,
  modelCount: 2,
  llmLastAt: new Date('2026-07-01T11:30:00.000Z'),
  computeCost: '0.75',
  computeSeconds: 120,
  computeLastAt: '2026-07-01T11:31:00.000Z',
};

const costWindow = {
  from: new Date('2026-07-01T00:00:00.000Z'),
  to: new Date('2026-07-08T00:00:00.000Z'),
};

beforeEach(() => {
  queryRecords = [];
  resultForQuery = () => [];
});

describe('listSessionCosts service', () => {
  test('paginates base sessions and attaches account-wide reconciliation', async () => {
    resultForQuery = (fields, table) => {
      if (table === projectSessions && 'projectName' in fields) return [joinedSessionRow];
      if (table === projectSessions && 'total' in fields) return [{ total: 2 }];
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
      window: costWindow,
      sort: 'total_desc',
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
      'leftJoin',
      'leftJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
    ]);
    expect(baseQuery?.calls.find((call) => call.method === 'limit')?.args).toEqual([1]);
    expect(baseQuery?.calls.find((call) => call.method === 'offset')?.args).toEqual([0]);
    // Two ORDER BY terms: the sort column and the session_id tiebreak that keeps
    // LIMIT/OFFSET paging totally ordered.
    expect(baseQuery?.calls.find((call) => call.method === 'orderBy')?.args).toHaveLength(2);
  });

  test('windows the LLM aggregate on created_at and the compute aggregate on started_at', async () => {
    resultForQuery = () => [];
    await listSessionCosts({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const llmAggregate = queryRecords.find(
      (query) => query.table === gatewayRequestLogs && 'llmCost' in query.fields,
    );
    const computeAggregate = queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'computeCost' in query.fields,
    );
    for (const aggregate of [llmAggregate, computeAggregate]) {
      expect(aggregate?.calls.map((call) => call.method)).toEqual(['where', 'groupBy', 'as']);
    }
    expect(llmAggregate?.calls.at(-1)?.args).toEqual(['llm_agg']);
    expect(computeAggregate?.calls.at(-1)?.args).toEqual(['compute_agg']);

    // Half-open [from, to) on the columns idx_gateway_logs_account_time and
    // idx_sandbox_compute_sessions_account_time cover.
    const llmWhere = renderWhere(llmAggregate);
    expect(llmWhere.sql).toContain('"created_at" >= $');
    expect(llmWhere.sql).toContain('"created_at" < $');
    expect(llmWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);

    const computeWhere = renderWhere(computeAggregate);
    expect(computeWhere.sql).toContain('"started_at" >= $');
    expect(computeWhere.sql).toContain('"started_at" < $');
    // last_billed_at's only index is partial (WHERE state = 'active'), so it
    // must never become the window column.
    expect(computeWhere.sql).not.toContain('last_billed_at');
    expect(computeWhere.params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
  });

  // Because Drizzle renders every SQL-aliased subquery field unqualified, each one
  // is resolved against the OUTER query's FROM clause. Three ways that has turned
  // into Postgres 42702, `column reference "..." is ambiguous`, which rejects the
  // whole statement at parse time:
  //   1. two subqueries claim the same alias   (the `last_at` bug this test was added for)
  //   2. an alias matches a real column on an outer table   (e.g. `status`)
  //   3. an alias matches a sibling subquery's field, even one never selected outward
  // All three are one rule — a name exposed by more than one FROM item — so assert
  // that rule rather than enumerating its symptoms. None of them are visible to a
  // row-shape assertion, because a double records SQL instead of executing it.
  test('the joined session select never references an ambiguous unqualified name', async () => {
    resultForQuery = () => [];
    await listSessionCosts({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const baseQuery = requireBaseSessionQuery();
    const identifiers = unqualifiedSelectIdentifiers(baseQuery);

    // A real floor, not a non-zero one. The select carries exactly 12 unqualified
    // fields — 9 from the LLM aggregate, 3 from the compute aggregate — so a
    // `> 0` check would still pass if 11 of them silently stopped rendering and
    // the checks below would then be guarding almost nothing.
    //
    // If you added a subquery field and landed here: bump this to 13, then re-read
    // the two assertions below and confirm your new alias is neither exposed by
    // another FROM item nor missing from the exposure map. Adding a field is
    // exactly when a new collision appears, which is why this routes you here.
    expect(identifiers).toHaveLength(12);

    const exposures = outerFromExposureCounts(baseQuery);

    // Self-consistency, and a vacuity guard for the assertion after it: every
    // selected identifier must resolve to at least one FROM item. A name missing
    // from the map means the two derivations disagree, and the ambiguity check
    // would then be comparing against nothing and passing for that reason.
    expect(identifiers.filter((name) => !exposures.has(name))).toEqual([]);

    expect(identifiers.filter((name) => (exposures.get(name) ?? 0) > 1)).toEqual([]);
  });

  test('windows the unassigned-cost reconciliation on the same bounds', async () => {
    resultForQuery = () => [];
    await listSessionCosts({
      accountId,
      window: costWindow,
      sort: 'total_desc',
      limit: 25,
      offset: 0,
    });

    const llmReconciliation = queryRecords.find(
      (query) =>
        query.table === gatewayRequestLogs &&
        'requests' in query.fields &&
        !('tokens' in query.fields),
    );
    const computeReconciliation = queryRecords.find(
      (query) => query.table === sandboxComputeSessions && 'windows' in query.fields,
    );

    expect(renderWhere(llmReconciliation).params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
    expect(renderWhere(computeReconciliation).params).toEqual([
      accountId,
      '2026-07-01T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
    ]);
  });

  // Postgres owns the order, and the mock records orderBy() without applying it,
  // so these render the ORDER BY to SQL. Asserting on emitted row order instead
  // would prove nothing about the query.
  async function orderByFor(sort: CostSort): Promise<string[]> {
    queryRecords = [];
    resultForQuery = () => [];
    await listSessionCosts({ accountId, window: costWindow, sort, limit: 25, offset: 0 });
    return renderOrderBy(requireBaseSessionQuery());
  }

  // The spend terms render as bare aliases, not as `"llm_agg"."llm_cost"`, because
  // Drizzle emits SQL-aliased subquery fields unqualified. Naming both aliases in
  // full also makes this fail if either one is renamed out from under the sort.
  test('total_desc orders by the coalesced spend of both subqueries, descending', async () => {
    const [spend, tiebreak] = await orderByFor('total_desc');
    expect(spend).toBe('(coalesce("llm_cost", 0) + coalesce("compute_cost", 0)) desc');
    expect(tiebreak).toBe(SESSION_ID_TIEBREAK);
  });

  test('total_asc orders by the same expression, ascending', async () => {
    const [spend, tiebreak] = await orderByFor('total_asc');
    expect(spend).toBe('(coalesce("llm_cost", 0) + coalesce("compute_cost", 0)) asc');
    expect(tiebreak).toBe(SESSION_ID_TIEBREAK);
  });

  test('recent orders by updated_at, descending, never by spend', async () => {
    const [recency, tiebreak] = await orderByFor('recent');
    expect(recency).toBe('"kortix"."project_sessions"."updated_at" desc');
    expect(tiebreak).toBe(SESSION_ID_TIEBREAK);
  });

  test('every sort ends in the session id tiebreak and nothing after it', async () => {
    for (const sort of ['total_desc', 'total_asc', 'recent'] as const) {
      const terms = await orderByFor(sort);
      expect(terms).toHaveLength(2);
      expect(terms.at(-1)).toBe(SESSION_ID_TIEBREAK);
    }
  });

  test('filters the page and the total by owner when one is supplied', async () => {
    resultForQuery = (fields, table) => {
      if (table === projectSessions && 'total' in fields) return [{ total: 0 }];
      return [];
    };

    await listSessionCosts({
      accountId,
      ownerId,
      window: costWindow,
      sort: 'recent',
      limit: 25,
      offset: 0,
    });

    // The page and the total must carry identical scope, or next_offset lies.
    const scopedQueries = queryRecords.filter((query) => query.table === projectSessions);
    expect(scopedQueries).toHaveLength(2);
    for (const query of scopedQueries) {
      const where = renderWhere(query);
      expect(where.sql).toContain('"created_by" = $');
      expect(where.params).toEqual([accountId, ownerId]);
    }
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
