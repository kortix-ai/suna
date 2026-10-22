// Migration: github_installations_one_per_owner_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// One GitHub connection per (account, owner). The previous unique index was
// `(account_id, installation_id)`, which a reconnect satisfies with a NEW
// installation id -- so the retired row stayed, both rows rendered as
// `github.com/<owner>`, and a create could pick the dead one (prod,
// 2026-09-25). `upsertAccountGitHubInstallation` now replaces same-owner rows
// inside one transaction; this index is what makes that an invariant rather
// than a convention.
//
// The preceding migration (…_github_installations_dedupe_by_owner) removes the
// existing duplicates. A duplicate left behind would fail this build and leave
// an INVALID index -- see MIGRATIONS.md "When it has already failed".
//
// The `(account_id, installation_id)` index stays: it is what an explicit
// `installation_id` lookup uses, and it keeps the same installation from being
// linked to one account twice.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create unique index concurrently if not exists uniq_account_github_installations_owner
      on kortix.account_github_installations (account_id, owner_login)
  `);
};

export const down = false;
