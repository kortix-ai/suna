// Migration: github_installations_dedupe_by_owner  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: deletes superseded kortix.account_github_installations rows,
// 500 per committed batch, keeping the newest row per (account_id,
// owner_login). Bounded by the table's own size -- one row per account per
// GitHub connection (low thousands on prod), and only duplicates are touched.
//
// WHY THERE ARE DUPLICATES
// Reconnecting the Kortix GitHub App mints a NEW installation id for the same
// owner. `upsertAccountGitHubInstallation` conflicted on `(account_id,
// installation_id)` only, so a reconnect INSERTed beside the retired row
// instead of replacing it. The retired id answers 404 forever after on
// `POST /app/installations/<id>/access_tokens` (verified against GitHub on
// 2026-09-25: the retired id 404, the current id 201), and both rows render as
// `github.com/<owner>`, so `/new` could send a create to the dead one. The user
// was then told "This GitHub connection is no longer valid. Reconnect it in
// Settings -> Git." immediately after reconnecting.
//
// This pass clears the existing duplicates; the next migration adds the unique
// index that stops them coming back, and the route now replaces same-owner rows
// inside one transaction.
//
// Deleting the OLDER rows is safe: an installation id is carried on
// `projects.metadata` only as part of a git connection that also names the
// owner, and the API re-resolves a project's installation by owner through
// `resolveGitHubRepoAuth`, which now heals a dead row on a 404 anyway.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // The house budget is correct here: this pass takes ROW locks, so a long
  // lock_timeout would queue writers behind it (the CONCURRENTLY rationale is
  // inverted for a DML file -- see lint-migrations.ts).
  pgm.sql(`set lock_timeout = '5s'`);
  pgm.sql(`set statement_timeout = '5min'`);

  // Batched in JS, not in a DO block: each query() runs on its own outside a
  // transaction (pgm.noTransaction()), so every batch commits and releases its
  // row locks before the next one starts. Idempotent -- once one row per pair
  // remains, the first batch deletes nothing and the loop ends.
  const BATCH = 500;
  // A bound, not an expectation: the table holds one row per account per GitHub
  // connection, so this can only spin if rows are being re-duplicated faster
  // than they are deleted, which the next migration's unique index prevents.
  const MAX_BATCHES = 1000;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      with superseded as (
        select installation_row_id
        from (
          select
            installation_row_id,
            row_number() over (
              partition by account_id, owner_login
              order by created_at desc, installation_id desc
            ) as rank
          from kortix.account_github_installations
        ) ranked
        where ranked.rank > 1
        limit ${BATCH}
      )
      delete from kortix.account_github_installations rows
      using superseded
      where rows.installation_row_id = superseded.installation_row_id
    `);
    if (!rowCount) break;
  }
};

export const down = false;
