// Migration: rbac_canonical_indexes  (CONCURRENTLY)
//
// The two indexes the canonical-RBAC model needs on EXISTING, live tables. They
// are here rather than in 20260819015724479_rbac_canonical_model.sql because a
// plain CREATE INDEX takes a write lock for the whole build, and both target
// tables are on request paths (iam_roles is joined by the engine's policy query;
// project_members is read by loadProjectForUser, 194 call sites).
//
//   1. kortix.iam_roles  uq_roles_system_key  UNIQUE (key, scope_type)
//                        WHERE account_id IS NULL
//      System roles have account_id NULL, where the existing
//      idx_iam_roles_account_key UNIQUE (account_id, key) does not dedupe —
//      NULLs are distinct. It cannot be (key) alone either: `member` is a
//      legitimate key at BOTH the account and the project scope.
//
//   2. kortix.project_members  project_members_project_id_user_id_pk
//                              UNIQUE (project_id, user_id)
//      Built here, promoted to the table's first real PRIMARY KEY by
//      20260819015724700_project_members_primary_key.sql via
//      ADD CONSTRAINT ... USING INDEX, which is a catalog update with no scan.
//      The index is named for the constraint it becomes so the promotion does
//      NOT rename it, and the pre-existing idx_project_members_project_user is
//      left untouched — it is every upsert's ON CONFLICT inference target, and
//      losing it is the 42P10 failure account_members already hit.
//
// Two CREATE INDEX CONCURRENTLY statements, on TWO DIFFERENT tables, awaited in
// sequence. The learnings rule is one CIC per TABLE at a time (two builds on the
// same table starve each other's lock-acquisition points and 55P03-thrash);
// serial builds on distinct tables are exactly what it prescribes.
// IF NOT EXISTS is deliberately NOT used: it silently keeps an INVALID shell
// left behind by a killed builder.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // One statement per pgm.sql() call — a multi-statement string goes through
  // the simple query protocol, which wraps it in an implicit transaction, and
  // CONCURRENTLY then fails with "cannot run inside a transaction block".
  await pgm.sql(`set lock_timeout = '5s'`);
  await pgm.sql(`set statement_timeout = '30min'`);

  await pgm.sql(
    `create unique index concurrently uq_roles_system_key
       on kortix.iam_roles (key, scope_type)
      where account_id is null`,
  );

  await pgm.sql(
    `create unique index concurrently project_members_project_id_user_id_pk
       on kortix.project_members (project_id, user_id)`,
  );
};

export const down = false;
