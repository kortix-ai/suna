// Migration: drop_unused_account_invitations_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Drops the two btree indexes the Supabase performance advisor flags
// (unused_index) on kortix.account_invitations:
//
//   idx_account_invitations_email    (email)
//   idx_account_invitations_account  (account_id)
//
// Evidence (prod pg_stat_user_indexes, read-only Management API, 2026-10-03):
// both have idx_scan = 0. The advisor has reported them unused since
// 2026-10-02. The table's other indexes are live and stay:
// idx_account_invitations_expires_at (62,920 scans) and
// idx_account_invitations_pending, unique (account_id, email) (5,578 scans).
//
// Why each drop changes no plan:
//   - email: every code lookup by email alone filters lower(email) = $1 —
//     autoClaimPendingInvites (accounts/core/app.ts), the caller-invite
//     listings (accounts/invites.ts, projects/routes/project-invites.ts) and
//     sso-sync.ts. A plain btree on email cannot serve lower(email), so this
//     index is architecturally unusable for them. The one plain email
//     equality (scim/users.ts) is ANDed with account_id and served by
//     idx_account_invitations_pending (account_id, email).
//   - account_id: idx_account_invitations_pending leads with account_id, so
//     every account_id predicate keeps an index, including the ON DELETE
//     CASCADE check from kortix.accounts. The advisor's
//     unindexed_foreign_keys lint does not flag account_invitations.
//
// Two drops, one logical change: one advisor finding (unused_index on
// kortix.account_invitations) — same shape as
// 20261003002832969_invitations_invited_by_index.concurrent.ts, which builds
// two indexes in one file. One statement per pgm.sql() call: a
// multi-statement string runs as an implicit transaction block and
// CONCURRENTLY then fails (see the template). IF EXISTS keeps a re-run safe.
//
// Fresh databases build the baseline (which creates both indexes) and then
// apply this file; the Drizzle snapshot no longer declares them, so
// schema-sync agrees with a freshly migrated catalog.

export const shorthands = undefined;

// mixed-version-safe: no code reads these index names anywhere (the only
// references are the baseline migration and this file), and no query plan
// depends on them — see the email/account_id analysis above. The indexes
// have idx_scan = 0 on prod (2026-10-03), so old code demonstrably never
// used them during any rollout window.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_invitations_email`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_invitations_account`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
