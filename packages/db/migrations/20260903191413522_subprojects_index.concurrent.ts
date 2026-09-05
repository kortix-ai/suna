// Migration: subprojects_index (NON-TRANSACTIONAL — CREATE INDEX CONCURRENTLY)
//
// Companion to 20260903191413521_subprojects. `project_sessions.subproject`
// is a new all-NULL column added there; this builds the index the subproject
// session filter (`GET /projects/:id/sessions?subproject=<slug>`) and the
// subproject page's session count need, without blocking writes on the hot
// `project_sessions` table. Partial: most rows carry NULL and never need
// indexing.
//
// lock_timeout is 180s, not the 2–5s house value: CREATE INDEX CONCURRENTLY
// waits on every transaction that started before it and blocks nobody while it
// waits (learnings 2026-08-19 "CIC under a 5-second lock_timeout").
//
// mixed-version-safe: index only. No code path depends on its presence.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(
    `create index concurrently if not exists "idx_project_sessions_project_subproject" on "kortix"."project_sessions" using btree ("project_id","subproject") where "kortix"."project_sessions"."subproject" is not null`,
  );
};

export const down = false;
