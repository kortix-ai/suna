// Migration: repo_snapshot_ref_alias_consolidation (NON-TRANSACTIONAL — chunked DML)
//
// `kortix.repo_snapshot_refs.ref` is keyed by branch name (`main`). Rows written
// before the key was normalized hold the full ref (`refs/heads/main`), and the
// two spellings are different rows under the table's unique key, so one branch
// could end up with two revisions of itself — one of them invisible to every
// canonical lookup and permanently due for reconciliation.
//
// The application already reads and writes through whichever spelling a row
// uses (`storedRefKey` in apps/api/src/repo-snapshots/store.ts), so this is a
// cleanup, not a cutover: it is safe before, during and after the rollout, in
// either order, and safe to run twice.
//
// Merge rule where BOTH spellings exist: the CANONICAL row wins and the alias
// is dropped. `revision` is a per-row counter, not a clock — it counts how many
// times THAT row was written, so a stale alias at revision 9 says nothing about
// a newer canonical row at revision 3, and comparing them would restore an old
// SHA. This is also exactly what the running application does when it finds
// both spellings (`storedRefKey`), so the migration cannot disagree with it.
//
// The canonical row's `desired_sha` and `revision` are left untouched, so no
// in-flight observation's CAS token is invalidated by the cleanup. Only the
// reconcile deadline moves, to the earlier of the two, so a recheck the alias
// was still owed is not lost. Where only the alias exists it is renamed in
// place, preserving its revision and its deadline.
//
// Chunked and incrementally committed: a plain .sql migration would hold
// ACCESS EXCLUSIVE for the whole data move (learnings 2026-08-10, "Never
// backfill data inside a single-transaction migration"). The table holds one
// row per repository ref, so this is small everywhere it exists at all — the
// batching is the rule, not a volume estimate.
//
// mixed-version-safe: an old replica that writes `refs/heads/x` again simply
// recreates an alias row, which the running application still resolves and a
// later run of this pass would consolidate.

// batched-dml: merges then renames `refs/heads/*` rows of kortix.repo_snapshot_refs,
// 500 rows per committed statement, bounded by one row per repository ref
// (thousands at most; the table is created by this same feature branch).

export const shorthands = undefined;

const BATCH = 500;

/**
 * The part of the node-pg-migrate builder this migration uses.
 *
 * Written out rather than imported so the file type-checks from the API test
 * that drives it against a real database.
 */
type MigrationBuilder = {
  noTransaction(): void;
  sql(text: string): Promise<unknown>;
  db: { query(text: string): Promise<{ rowCount: number | null }> };
};

export const up = async (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '5s'`);

  for (;;) {
    // Both spellings present: fold the alias into the canonical row.
    const merged = await pgm.db.query(`
      with doomed as (
        select alias.provider, alias.repository_id, alias.ref
        from kortix.repo_snapshot_refs alias
        join kortix.repo_snapshot_refs canonical
          on canonical.provider = alias.provider
         and canonical.repository_id = alias.repository_id
         and canonical.ref = regexp_replace(alias.ref, '^refs/heads/', '')
        where alias.ref like 'refs/heads/%'
        limit ${BATCH}
      ),
      promoted as (
        update kortix.repo_snapshot_refs canonical
        set reconcile_after = least(
              coalesce(canonical.reconcile_after, alias.reconcile_after),
              coalesce(alias.reconcile_after, canonical.reconcile_after)),
            updated_at = now()
        from kortix.repo_snapshot_refs alias
        join doomed on doomed.provider = alias.provider
                   and doomed.repository_id = alias.repository_id
                   and doomed.ref = alias.ref
        where canonical.provider = alias.provider
          and canonical.repository_id = alias.repository_id
          and canonical.ref = regexp_replace(alias.ref, '^refs/heads/', '')
        returning canonical.ref
      )
      delete from kortix.repo_snapshot_refs victim
      using doomed
      where victim.provider = doomed.provider
        and victim.repository_id = doomed.repository_id
        and victim.ref = doomed.ref`);
    if ((merged.rowCount ?? 0) === 0) break;
  }

  for (;;) {
    // Alias only: rename in place, keeping its revision and its deadline.
    const renamed = await pgm.db.query(`
      update kortix.repo_snapshot_refs
      set ref = regexp_replace(ref, '^refs/heads/', ''), updated_at = now()
      where (provider, repository_id, ref) in (
        select provider, repository_id, ref
        from kortix.repo_snapshot_refs
        where ref like 'refs/heads/%'
        limit ${BATCH}
      )`);
    if ((renamed.rowCount ?? 0) === 0) break;
  }
};

// Forward-only. Re-splitting one branch back into two rows would restore the
// invisible duplicate this removes.
export const down = false;
