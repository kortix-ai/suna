/**
 * The project-led gateway aggregates (gateway budgets memberRows/projectAgg,
 * budgetSpends, gateway overview, gateway series) scanned
 * kortix.gateway_request_logs by (project_id, created_at) and heap-fetched
 * every wide jsonb row because idx_gateway_logs_project_time carries none of
 * the aggregated columns. Prod (Better Stack 2346961, 2026-10-18 07:54): the
 * 15-minute budgets poll of a busy project crossed the 25 s statement timeout
 * (503 + error page) while its neighbors ran 2-14 s every poll — the latency
 * is heap I/O. idx_gateway_logs_project_time_covering
 * (20261020080000000) carries every column those aggregates read, so the
 * plans become index-only.
 *
 * The assertion reads the live catalog and the live planner (EXPLAIN), never
 * source text: the budgets aggregate's exact shape must plan as an Index Only
 * Scan over the covering index, and dropping the index must flip the plan
 * back to the heap path — so the test fails without the migration.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const INDEX = 'idx_gateway_logs_project_time_covering';

/** The projectAgg statement of GET /:projectId/gateway/budgets (gateway-spend.ts),
 *  with the same money expression llm-spend.ts composes. */
const BUDGETS_PROJECT_AGG = `
  select count(*)::int,
         coalesce(sum(
           final_cost_precise + case when coalesce(
             billing_mode,
             case when final_cost_precise > 0 then 'credits' else 'none' end
           ) = 'credits' then 0 else upstream_cost_precise end
         ), 0)::float8
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= date_trunc('month', now())
`;

/** The gateway series shape: same scan, tokens + errors + latency percentiles. */
const SERIES = `
  select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
         count(*)::int,
         count(*) filter (where not ok)::int,
         coalesce(sum(final_cost_precise + case when coalesce(
             billing_mode,
             case when final_cost_precise > 0 then 'credits' else 'none' end
           ) = 'credits' then 0 else upstream_cost_precise end), 0)::float8,
         coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= now() - make_interval(days => 30)
   group by 1
`;

suite('gateway_request_logs project aggregates are index-only', () => {
  let client: pg.Client;
  let superuser: pg.Client;
  const projectId = crypto.randomUUID();
  const accountId = crypto.randomUUID();

  const planOf = async (sql: string): Promise<string> => {
    const { rows } = await client.query<{ plan: unknown[] }>(`explain (costs off) ${sql}`, [
      projectId,
    ]);
    return rows.map((r) => String(r["QUERY PLAN"])).join("\n");
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    superuser = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
    await client.connect();
    await superuser.connect();
    await client.query('insert into kortix.accounts (account_id, name) values ($1, $2) on conflict do nothing', [accountId, accountId]);
    await client.query(
      `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1, $2, 'covering-index-test', 'https://example.test/covering.git')
       on conflict (project_id) do nothing`,
      [projectId, accountId],
    );
    // 4k month-to-date rows with a request payload, so the heap is wider than
    // the index. Size is not what the plans below rest on (`enable_seqscan =
    // off` is): 40k rows of 2 KB timed the setup out at 30 s on a loaded CI
    // runner.
    await client.query(
      `insert into kortix.gateway_request_logs
         (account_id, project_id, request_id, session_id, provider, resolved_model, requested_model,
          status, billing_mode, ok, latency_ms, input_tokens, output_tokens,
          final_cost_precise, upstream_cost_precise, request, created_at)
       select $1, $2,
              'req-' || i,
              case when i % 3 = 0 then null else gen_random_uuid()::text end,
              'kortix', 'gpt-5', 'gpt-5',
              200,
              case when i % 4 = 0 then null else 'credits' end,
              i % 17 > 0, (i % 900)::int, (i % 500)::int, (i % 900)::int,
              ((i % 50) * 0.001)::numeric, ((i % 80) * 0.001)::numeric,
              jsonb_build_object('messages', repeat('x', 200)),
              date_trunc('month', now()) + ((i % 400) || ' minutes')::interval
         from generate_series(1, 4000) as i`,
      [accountId, projectId],
    );
    await superuser.query('vacuum analyze kortix.gateway_request_logs');
    // The Index-Only-Scan choice is scale-dependent planner behavior (the
    // KRTX-1769 precedent asserts presence instead for exactly this reason).
    // This test needs the structural claim, not the cost race: with seq scans
    // disabled the planner must produce an index-only plan over the covering
    // index if — and only if — every column the aggregate reads lives in it.
    // Without the INCLUDE columns the same statement plans as a heap-fetching
    // Index Scan, so the assertion still discriminates.
    await client.query('set enable_seqscan = off');
  });

  afterAll(async () => {
    if (!client) return;
    await client
      .query('delete from kortix.gateway_request_logs where project_id = $1', [projectId])
      .catch(() => undefined);
    await client.query('delete from kortix.projects where project_id = $1', [projectId]).catch(
      () => undefined,
    );
    await client
      .query('delete from kortix.accounts where account_id = $1', [accountId])
      .catch(() => undefined);
    await client.end();
    await superuser.end();
  });

  test('the budgets project aggregate plans as an index-only scan of the covering index', async () => {
    const plan = await planOf(BUDGETS_PROJECT_AGG);
    expect(plan).toContain('Index Only Scan');
    expect(plan).toContain(INDEX);
  });

  test('the gateway series plans as an index-only scan too (needs latency_ms carried)', async () => {
    const plan = await planOf(SERIES);
    expect(plan).toContain('Index Only Scan');
    expect(plan).toContain(INDEX);
  });

  test('the index carries exactly the columns the aggregates read', async () => {
    const { rows } = await superuser.query<{ indexdef: string }>(
      `select pg_get_indexdef(c.oid) as indexdef
         from pg_class c
        where c.relname = $1 and c.relkind = 'i'`,
      [INDEX],
    );
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain('ON kortix.gateway_request_logs USING btree (project_id, created_at)');
    for (const column of [
      'ok',
      'billing_mode',
      'final_cost_precise',
      'upstream_cost_precise',
      'input_tokens',
      'output_tokens',
      'latency_ms',
      'actor_user_id',
    ]) {
      expect(def).toContain(column);
    }
  });

  test('dropping the index flips the plan back to the heap path (the test is not vacuous)', async () => {
    await superuser.query(`drop index if exists kortix.${INDEX}`);
    const plan = await planOf(BUDGETS_PROJECT_AGG);
    expect(plan).not.toContain(INDEX);
    // Rebuild with the migration's own statement, so the test also proves the
    // migration's SQL is what creates the index the other tests assert on.
    await superuser.query(`set lock_timeout = '30s'`);
    await superuser.query(`set statement_timeout = '5min'`);
    await superuser.query(`
      create index if not exists ${INDEX}
        on kortix.gateway_request_logs (project_id, created_at) include (
          ok, billing_mode, final_cost_precise, upstream_cost_precise,
          input_tokens, output_tokens, latency_ms, actor_user_id
        )`);
    expect(await planOf(BUDGETS_PROJECT_AGG)).toContain(INDEX);
  });
});
