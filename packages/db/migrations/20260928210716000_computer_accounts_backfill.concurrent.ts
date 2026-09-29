// Migration: computer_accounts_backfill  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: three idempotent passes, each a loop of short committed
// statements. Bounds measured read-only on 2026-09-28: dev holds 52 machines
// and 70 computer connectors (49 with tunnel_ids, 88 existing machine refs);
// staging holds 353 machines and 2068 computer connectors (none with
// tunnel_ids). Every row a pass touches leaves its selection predicate, so
// each loop ends when a batch updates nothing.
//
// 1. tunnel_connections.owner_user_id = account_id for machines paired under
//    a PERSONAL account. A personal account's id IS its creator's user id
//    (resolve-account.ts bootstrapPersonalAccount), so the predicate is "the
//    account id is a row of auth.users". Team-account machines keep NULL:
//    account managers own them.
//
// 2. Every computer account without a machine (the project-default slot the
//    old sync created on each computer connector) is revoked and loses its
//    default pin. It never reached a machine: the old gateway routed by the
//    connector's config.tunnel_ids, not by the connection. Freeing the pin lets
//    pass 3 pin the first migrated account.
//
// 3. Each computer connector's config.tunnel_ids becomes one account per
//    machine that still exists: member-owned by owner_user_id for a personal
//    machine, project-owned otherwise. Label = machine name, " (n)" suffix on
//    a duplicate name for the same owner; the first account per owner is the
//    default. The same statement removes tunnel_ids, tunnel_account_ids,
//    computer_profile and tunnel_id from the connector config, so a connector
//    is converted exactly once. ON CONFLICT DO NOTHING drops a machine only
//    when its label collides with a revoked slot label (the connector name);
//    its owner re-adds it with one click.
//
// Order matters: pass 3 reads owner_user_id from pass 1 and the free default
// pin from pass 2. Row locks only; the house 5s lock budget keeps writers from
// queueing behind a batch.

export const shorthands = undefined;

const BATCH = 200;
// A bound, not an expectation: every pass shrinks its own selection.
const MAX_BATCHES = 1000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the passes below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  const loop = async (statement) => {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const { rowCount } = await pgm.db.query(statement);
      if (!rowCount) return;
    }
    throw new Error('computer_accounts_backfill: batch bound reached');
  };

  await loop(`
    update kortix.tunnel_connections tc
       set owner_user_id = tc.account_id
     where tc.tunnel_id in (
       select t.tunnel_id
         from kortix.tunnel_connections t
        where t.owner_user_id is null
          and exists (select 1 from auth.users u where u.id = t.account_id)
        limit ${BATCH}
     )
  `);

  await loop(`
    update kortix.connector_connections cc
       set status = 'revoked', is_default = false, updated_at = now()
     where cc.connection_id in (
       select x.connection_id
         from kortix.connector_connections x
         join kortix.connectors c on c.connector_id = x.connector_id
        where c.provider_type = 'computer'
          and x.tunnel_id is null
          and (x.status <> 'revoked' or x.is_default)
        limit ${BATCH}
     )
  `);

  await loop(`
    with batch as (
      select c.connector_id, c.account_id, c.project_id, c.config
        from kortix.connectors c
       where c.provider_type = 'computer'
         and (c.config ? 'tunnel_ids' or c.config ? 'tunnel_account_ids'
              or c.config ? 'computer_profile' or c.config ? 'tunnel_id')
       order by c.connector_id
       limit ${BATCH}
       for update
    ),
    machines as (
      select distinct on (b.connector_id, tc.tunnel_id)
             b.connector_id, b.account_id, b.project_id, tc.tunnel_id,
             left(tc.name, 240) as name,
             case when tc.owner_user_id is null then 'project' else 'member' end as owner_type,
             tc.owner_user_id::text as owner_id,
             refs.ord
        from batch b
       cross join lateral jsonb_array_elements_text(
               case when jsonb_typeof(b.config -> 'tunnel_ids') = 'array'
                    then b.config -> 'tunnel_ids' else '[]'::jsonb end
             ) with ordinality as refs(id, ord)
        join kortix.tunnel_connections tc on tc.tunnel_id::text = refs.id
         -- The old profile editor accepted the project's account machines and
         -- the editor's personal ones. An owner-less machine of any other
         -- account (its personal owner was deleted) never becomes a shared
         -- account in this project.
         and (tc.owner_user_id is not null or tc.account_id = b.account_id)
       order by b.connector_id, tc.tunnel_id, refs.ord
    ),
    ranked as (
      select m.*,
             row_number() over (
               partition by m.connector_id, m.owner_type, m.owner_id, lower(m.name) order by m.ord
             ) as duplicate,
             row_number() over (
               partition by m.connector_id, m.owner_type, m.owner_id order by m.ord
             ) as position
        from machines m
    ),
    inserted as (
      insert into kortix.connector_connections
        (account_id, project_id, connector_id, owner_type, owner_id, label, status, is_default, metadata, tunnel_id)
      select r.account_id, r.project_id, r.connector_id,
             r.owner_type::kortix.connector_connection_owner_type, r.owner_id,
             case when r.duplicate = 1 then r.name else r.name || ' (' || r.duplicate || ')' end,
             'active', r.position = 1, '{}'::jsonb, r.tunnel_id
        from ranked r
      on conflict do nothing
      returning connection_id
    )
    update kortix.connectors c
       set config = c.config - 'tunnel_ids' - 'tunnel_account_ids' - 'computer_profile' - 'tunnel_id',
           updated_at = now()
      from batch b
     where c.connector_id = b.connector_id
  `);
};

export const down = false;
