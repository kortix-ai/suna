// Migration: confine_connector_bound_secrets (NON-TRANSACTIONAL — batched DML)
//
// Connector bindings are a server-side credential boundary. Older projects can
// still have a shared project_secret row with scope=runtime while a connector's
// auth_secret references the same identifier. Sandbox assembly now excludes
// bound identifiers independently. This migration repairs the stored policy.
//
// batched-dml: updates at most 1,000 rows per transaction. Each batch selects
// only rows that still differ from connector/broker policy, so reruns are safe.
// The loop is bounded by the finite project_secrets table.
//
// mixed-version-safe: DATA only. Old API replicas understand every value used
// here. Narrowing a connector-bound credential removes sandbox access and does
// not grant a new capability.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '120s'`);

  let total = 0;
  for (let batch = 0; batch < 100_000; batch += 1) {
    const result = await pgm.db.query(`
      with candidates as (
        select ps.secret_id
          from kortix.project_secrets ps
         where ps.owner_user_id is null
           and exists (
             select 1
               from kortix.connectors c
              where c.project_id = ps.project_id
                and c.auth_secret = ps.identifier
           )
           and (
             ps.scope <> 'connector'
             or ps.strategy <> 'broker'
             or ps.consumer <> 'connector'
             or ps.strategy_locked is not true
           )
         limit 1000
         for update skip locked
      )
      update kortix.project_secrets ps
         set scope = 'connector',
             strategy = 'broker',
             consumer = 'connector',
             strategy_locked = true,
             updated_at = now()
        from candidates
       where ps.secret_id = candidates.secret_id
    `);
    const count = result.rowCount ?? 0;
    total += count;
    if (count === 0) {
      // eslint-disable-next-line no-console
      console.log(`[confine_connector_bound_secrets] confined ${total} secret(s)`);
      return;
    }
  }
  throw new Error(
    '[confine_connector_bound_secrets] rows remain after 100,000 batches; aborting',
  );
};

export const down = false;
