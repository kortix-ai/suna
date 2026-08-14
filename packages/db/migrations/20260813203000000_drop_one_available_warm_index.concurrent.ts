// Migration: drop_one_available_warm_index
//
// mixed-version-safe: DROP INDEX only, plus a metadata key rename. The index
// `idx_project_sessions_one_available_warm` was never read by a query — it was a
// write-side arbiter for the warm-session create race. Removing it cannot break
// a read on either side of the deploy. An old API replica writing
// `metadata.warm_session.state = 'available'` after this runs simply loses its
// duplicate protection for the length of the rollout; the worst case is one
// extra sandbox, already bounded by the reserved concurrent-session slot.
//
// The second half renames the marker the `visible` session list filters on:
// `metadata.warm_session` (a 3-state object) becomes `metadata.warm` (present ⇒
// pre-created and never used). Rows are rewritten so a warm session that was
// hidden before this deploy stays hidden after it.
//
// `available` and `discarded` both meant "nobody ever used this row", so both
// become `warm: true`. `claimed` meant "in use", so the key is simply removed
// and the row keeps listing as it already did. `{"legacy": true}` is not used:
// the value is a plain boolean because nothing reads anything else from it.
//
// Blast radius: PRs #6437/#6439 shipped the `warm_session` marker to `main` on
// 2026-08-13 and have never been in `staging`, `prod` or any release tag
// (`git tag --contains 4a465bf89e` is empty), so the only rows this touches are
// on the dev data plane.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_project_sessions_one_available_warm`);
  pgm.sql(`
    update kortix.project_sessions
       set metadata = (metadata - 'warm_session') || '{"warm": true}'::jsonb
     where metadata->'warm_session'->>'state' in ('available', 'discarded')
  `);
  pgm.sql(`
    update kortix.project_sessions
       set metadata = metadata - 'warm_session'
     where metadata ? 'warm_session'
  `);
};

export const down = false;
