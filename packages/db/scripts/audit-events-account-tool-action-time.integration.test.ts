/**
 * The audit list's connector/computer filter — GET /v1/accounts/:id/audit?
 * action=connector. — walked the account's WHOLE recent ledger on
 * idx_audit_events_account_time, heap-fetching every wide jsonb row between
 * tool calls until it had found 50 matches. Prod (Better Stack 2346961,
 * 2026-10-17 21:10): the query crossed the 25 s statement timeout (503 +
 * error page) and its sibling filters on the same account ran 9-15 s.
 *
 * idx_audit_events_account_tool_action_time (20261020080001000) is partial on
 * exactly the two LIKE prefixes the filter builds (audit-filters.ts), so
 * every index entry IS a row the query wants: the plan walks one account's
 * tool rows newest-first, in the query's own order, and stops at LIMIT.
 *
 * The assertion reads the live planner (EXPLAIN), never source text, and the
 * drop-rebuild control proves it fails without the migration.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const INDEX = 'idx_audit_events_account_tool_action_time';
/** EXPLAIN prints the per-partition CHILD index names, not the parent's. */
const CHILD_PREFIX = 'idx_ae_tool_time_';

/** The audit list shape for `action=connector.` (audit.ts + audit-filters.ts). */
const AUDIT_CONNECTOR_PAGE = `
  select *
    from kortix.audit_events_all
   where account_id = $1
     and (action like 'connector.%' or action like 'computer.%')
   order by occurred_at desc, event_id desc
   limit 50
`;

suite('audit_events connector/computer filter is index-driven', () => {
  let client: pg.Client;
  let superuser: pg.Client;
  const accountId = crypto.randomUUID();

  const planOf = async (): Promise<string> => {
    const { rows } = await client.query<{ plan: unknown[] }>(
      `explain (costs off) ${AUDIT_CONNECTOR_PAGE}`,
      [accountId],
    );
    return rows.map((r) => String(r["QUERY PLAN"])).join("\n");
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    superuser = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
    await client.connect();
    await superuser.connect();
    await client.query('insert into kortix.accounts (account_id, name) values ($1, $2) on conflict do nothing', [accountId, accountId]);
    // A busy ledger: mostly non-tool rows (auth/session/gateway actions),
    // every 9th row a connector or computer tool action — the 2:7 sparsity
    // that made the unfiltered walk pay heap fetches for row after row it
    // could not use.
    await client.query(
      `insert into kortix.audit_events (event_id, account_id, resource_type, action, occurred_at, metadata)
       select gen_random_uuid(),
              $1,
              case when i % 9 = 0 and i % 18 = 0 then 'connector'
                   when i % 9 = 0 then 'computer'
                   else 'session' end,
              case when i % 9 = 0 and i % 18 = 0 then 'connector.tool.executed'
                   when i % 9 = 0 then 'computer.tool.executed'
                   else 'session.message.completed' end,
              now() - ((i % 2880) || ' minutes')::interval,
              jsonb_build_object('detail', repeat('x', 1500))
         from generate_series(1, 30000) as i`,
      [accountId],
    );
    await superuser.query('vacuum analyze kortix.audit_events');
  });

  afterAll(async () => {
    if (!client) return;
    await client
      .query('delete from kortix.audit_events where account_id = $1', [accountId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.accounts where account_id = $1', [accountId])
      .catch(() => undefined);
    await client.end();
    await superuser.end();
  });

  test('the connector/computer page plans through the partial tool-action index', async () => {
    const plan = await planOf();
    expect(plan).toContain(CHILD_PREFIX);
  });

  test('every existing partition carries a valid attached child index', async () => {
    const { rows } = await client!.query<{ partition: string; children: string; valid: number }>(
      `select p.relname as partition,
              count(c.oid)::text as children,
              coalesce(bool_and(i.indisvalid), false)::int as valid
         from pg_inherits t
         join pg_class p on p.oid = t.inhrelid
         left join pg_inherits ci on ci.inhparent = 'kortix.${INDEX}'::regclass
         left join pg_class c on c.oid = ci.inhrelid and c.relname like '${CHILD_PREFIX}' || replace(p.relname, 'audit_events_', '')
         left join pg_index i on i.indexrelid = c.oid
        where t.inhparent = 'kortix.audit_events'::regclass
        group by p.relname`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({ partition: row.partition, children: row.children, valid: row.valid }).toEqual({
        partition: row.partition,
        children: '1',
        valid: 1,
      });
    }
  });

  test('a partition created AFTER the migration inherits the tool-action index', async () => {
    // The runtime partition creator (ensure_partitions) must not need to know
    // about this index: ATTACH PARTITION auto-creates the parent's partitioned
    // indexes on the new partition.
    await client!.query(`select kortix.audit_events_ensure_partitions('kortix.audit_events', (current_date + 7)::date, 1)`);
    const nextWeek = await client!.query<{ relname: string }>(
      `select p.relname from pg_inherits t join pg_class p on p.oid = t.inhrelid
        where t.inhparent = 'kortix.audit_events'::regclass
          and p.relname like 'audit_events_p%' order by p.relname desc limit 1`,
    );
    const newest = nextWeek.rows[0]!.relname;
    // Name-independent: the auto-created child's name is Postgres-generated,
    // not the migration's child naming. Match by the index's TABLE instead.
    const { rows } = await client!.query<{ children: string }>(
      `select count(c.oid)::text as children
         from pg_inherits ci
         join pg_class c on c.oid = ci.inhrelid
         join pg_index i on i.indexrelid = c.oid
        where ci.inhparent = 'kortix.${INDEX}'::regclass
          and i.indrelid = ('kortix.' || $1)::regclass
          and i.indisvalid`,
      [newest],
    );
    expect(rows[0]!.children).toBe('1');
  });

  test('dropping the index flips the plan back to the ledger walk (the test is not vacuous)', async () => {
    await superuser!.query(`drop index if exists kortix.${INDEX}`);
    const plan = await planOf();
    expect(plan).not.toContain(CHILD_PREFIX);
    // Rebuild with the migration's own flow, so the test also proves that flow
    // is what creates the index the other tests assert on.
    await superuser!.query(`set lock_timeout = '30s'`);
    await superuser!.query(`set statement_timeout = '5min'`);
    const definition = `(account_id, occurred_at, event_id) where action like 'connector.%' or action like 'computer.%'`;
    await superuser!.query(`create index if not exists ${INDEX} on only kortix.audit_events ${definition}`);
    const { rows: partitions } = await superuser!.query<{ relname: string }>(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'kortix.audit_events'::regclass order by c.relname`,
    );
    for (const { relname } of partitions) {
      const child = `${CHILD_PREFIX}${relname.replace('audit_events_', '')}`;
      await superuser!.query(`create index if not exists ${child} on kortix.${relname} ${definition}`);
      await superuser!.query(`alter index kortix.${INDEX} attach partition kortix.${child}`);
    }
    expect(await planOf()).toContain(CHILD_PREFIX);
  });

  test('the partial predicate matches the filter the route builds', async () => {
    const { rows } = await superuser.query<{ indexdef: string }>(
      `select pg_get_indexdef(c.oid) as indexdef
         from pg_class c
        where c.relname = $1 and c.relkind = 'I'`,
      [INDEX],
    );
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain("'connector.%'");
    expect(def).toContain("'computer.%'");
    expect(def).toContain('(account_id, occurred_at, event_id)');
  });
});
