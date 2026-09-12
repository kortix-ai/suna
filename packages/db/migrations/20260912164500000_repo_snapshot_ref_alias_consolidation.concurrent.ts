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
// both spellings, so the migration cannot disagree with it. The canonical row's
// `desired_sha` and `revision` are left untouched, so no in-flight observation's
// CAS token is invalidated by the cleanup; only the reconcile deadline moves, to
// the earlier of the two, so a recheck the alias was still owed is not lost.
//
// CONCURRENCY. Each branch is consolidated while holding the same advisory lock
// the application takes for that branch (`withRefLock`), computed identically:
// `hashtextextended('<provider>:<repository_id>:<canonical ref>', 0)`. Inside
// that lock the "does a canonical row exist" test and the write that depends on
// it are atomic, so a rolling writer cannot create the canonical row between
// them and turn the rename into a 23505. The lock is held for one branch at a
// time, never for the whole pass.
//
// Chunked and incrementally committed: a plain .sql migration would hold
// ACCESS EXCLUSIVE for the whole data move (learnings 2026-08-10, "Never
// backfill data inside a single-transaction migration"). The table holds one
// row per repository ref, so this is small everywhere it exists at all — the
// batching is the rule, not a volume estimate.
//
// mixed-version-safe: an old replica that writes `refs/heads/x` again simply
// recreates an alias row, which the running application still resolves and a
// later run of this pass would consolidate. Such a replica does not take the
// advisory lock, which is why the per-branch work is also written to be correct
// without it — the `exists` test and the write are one statement each, and a
// rename that would collide is skipped and folded by the next pass instead.

// batched-dml: consolidates `refs/heads/*` rows of kortix.repo_snapshot_refs,
// 100 branches per committed DO block, each under that branch's advisory lock,
// bounded by one row per repository ref (thousands at most; the table is
// created by this same feature branch).

export const shorthands = undefined;

/** Branches consolidated per committed statement. */
const BATCH = 100;
/** Enough passes to drain any plausible table; a stuck pass must not spin forever. */
const MAX_PASSES = 1000;

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

/**
 * One committed batch, exported so a test or an operator can drive the real
 * statement instead of a copy of it.
 */
export const CONSOLIDATE_BATCH_SQL = `
do $$
declare
  target record;
  canonical text;
begin
  for target in
    select provider, repository_id, ref
    from kortix.repo_snapshot_refs
    where ref like 'refs/heads/%'
    order by provider, repository_id, ref
    limit ${BATCH}
  loop
    canonical := regexp_replace(target.ref, '^refs/heads/', '');
    -- The same key apps/api/src/repo-snapshots/store.ts locks for this branch.
    perform pg_advisory_xact_lock(
      hashtextextended(target.provider || ':' || target.repository_id || ':' || canonical, 0));

    if exists (
      select 1 from kortix.repo_snapshot_refs canonical_row
      where canonical_row.provider = target.provider
        and canonical_row.repository_id = target.repository_id
        and canonical_row.ref = canonical
    ) then
      update kortix.repo_snapshot_refs canonical_row
      set reconcile_after = least(
            coalesce(canonical_row.reconcile_after, alias.reconcile_after),
            coalesce(alias.reconcile_after, canonical_row.reconcile_after)),
          updated_at = now()
      from kortix.repo_snapshot_refs alias
      where canonical_row.provider = target.provider
        and canonical_row.repository_id = target.repository_id
        and canonical_row.ref = canonical
        and alias.provider = target.provider
        and alias.repository_id = target.repository_id
        and alias.ref = target.ref;

      delete from kortix.repo_snapshot_refs
      where provider = target.provider
        and repository_id = target.repository_id
        and ref = target.ref;
    else
      update kortix.repo_snapshot_refs
      set ref = canonical, updated_at = now()
      where provider = target.provider
        and repository_id = target.repository_id
        and ref = target.ref;
    end if;
  end loop;
end $$`;

/**
 * How many legacy rows are left, as a ROW COUNT rather than a value.
 *
 * Every driver reports the number of rows a SELECT returned — `rowCount` on
 * node-pg, `count` on postgres-js — while the shape of the rows themselves
 * differs between them. Counting rows is the one answer they all agree on, so
 * the loop below never has to know which driver it is running under.
 */
export const REMAINING_ALIASES_SQL = `
  select 1 from kortix.repo_snapshot_refs where ref like 'refs/heads/%'`;

/** @param pgm the node-pg-migrate builder */
export const up = async (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '5s'`);

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const remaining = Number((await pgm.db.query(REMAINING_ALIASES_SQL)).rowCount ?? 0);
    if (remaining === 0) return;
    await pgm.db.query(CONSOLIDATE_BATCH_SQL);
    const left = Number((await pgm.db.query(REMAINING_ALIASES_SQL)).rowCount ?? 0);
    // A pass that consolidates nothing while rows remain means a writer is
    // recreating them as fast as we remove them; stop rather than spin. What is
    // left is still correct, just not yet consolidated, and the application
    // reads it either way.
    if (left >= remaining) return;
  }
};

// Forward-only. Re-splitting one branch back into two rows would restore the
// invisible duplicate this removes.
export const down = false;
