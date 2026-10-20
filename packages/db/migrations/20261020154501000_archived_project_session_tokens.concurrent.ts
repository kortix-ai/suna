// Migration: archived_project_session_tokens
// batched-dml: revoke archived-project session credentials, 1000 rows per commit, at most 10000 batches.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '30s'`);
  for (let batch = 0; batch < 10000; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      update kortix.account_tokens t
         set status = 'revoked', revoked_at = coalesce(t.revoked_at, now())
       where t.token_id in (
         select token_id from kortix.account_tokens t
         join kortix.projects p on p.project_id = t.project_id and p.account_id = t.account_id
         where t.session_id is not null and t.status = 'active' and p.status = 'archived'
         limit 1000
       ) and t.status = 'active'
    `);
    if (!rowCount) return;
  }
  throw new Error('archived_project_session_tokens: batch bound reached');
};
