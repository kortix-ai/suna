// Migration: retire_warm_session_drafts  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: kortix.project_sessions rows with `metadata.warm = true`, 500
// per batch. Bounds measured read-only on 2026-11-03 (marked rows / of them
// already soft-deleted / all rows): prod 8,111 / 505 / 77,129, staging
// 2,306 / 107 / 21,689, dev 1,155 / 248 / 8,071. One batch selection takes
// 0.2 s on prod, a full scan 1.1 s. An updated row loses the marker and leaves
// the selection, so the loop ends when a batch changes nothing.
//
// Warm sessions were removed on 2026-11-03. A warm session was created before
// anyone typed, and `metadata.warm = true` meant "never prompted": no row in
// prod had a turn or a session-log message (read-only check, 2026-11-03). Only
// that marker hid them from the sidebar, and the code that read it is gone.
//
// Each marked row becomes an ordinary soft-deleted session, the state
// `deleteSession` writes, and loses the marker:
//
// - `deletedAt` is the time the session ended (`updated_at`, or the delete
//   time it already has), capped at 31 days ago. The restore window is 30
//   days (SESSION_DELETE_ROWS_DAYS), so no row reaches "Recently deleted":
//   1,297 prod users would otherwise see up to 293 sessions they never
//   started. The retention purge then deletes the content rows and files and
//   keeps the row as a shell, as for every deleted session.
// - `deletedBy` keeps its value, else 'system' (no person deleted it).
//
// The row is not deleted: compute billing (3,666 prod rows in
// sandbox_compute_sessions) and the cost rollups name it. `updated_at` stays,
// as on every delete. `status` stays, so the status audit trigger does not
// fire; the title trigger returns early (the title does not change).
// Row locks only; the house 5s lock budget keeps writers from queueing behind
// a batch.

export const shorthands = undefined;

const BATCH = 500;
// A bound, not an expectation: every batch shrinks its own selection.
const MAX_BATCHES = 10000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the batches below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      update kortix.project_sessions s
         set metadata = (s.metadata - 'warm') || jsonb_build_object(
               'deletedAt', to_char(
                 least(
                   case
                     when s.metadata->>'deletedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
                       then (s.metadata->>'deletedAt')::timestamptz
                     else s.updated_at
                   end,
                   now() - interval '31 days'
                 ) at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ),
               'deletedBy', coalesce(s.metadata->'deletedBy', to_jsonb('system'::text))
             )
       where s.session_id in (
         select w.session_id
           from kortix.project_sessions w
          where w.metadata->>'warm' = 'true'
          limit ${BATCH}
       )
    `);
    if (!rowCount) return;
  }
  throw new Error('retire_warm_session_drafts: batch bound reached');
};

export const down = false;
