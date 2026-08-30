import type { CraftEntrySpec } from './crafts';

/**
 * One materialized `project_crafts` row, as the reconciler needs to see it.
 * Deliberately narrower than the table: these are the only fields the manifest
 * can express, so they are the only ones a reconcile may compare or write.
 */
export interface ProjectCraftRow {
  slug: string;
  repoOwner?: string | null;
  repoName?: string | null;
  gitRef?: string | null;
  resolvedSha?: string | null;
  title?: string | null;
  owns?: Record<string, string[]> | null;
}

export interface ProjectCraftCatalogStore {
  list(projectId: string): Promise<ProjectCraftRow[]>;
  upsert(projectId: string, spec: CraftEntrySpec): Promise<void>;
  remove(projectId: string, slug: string): Promise<void>;
}

/** Stable comparison of two `owns` maps — key order and list order never matter. */
function ownsEqual(
  a: Record<string, string[]> | null | undefined,
  b: CraftEntrySpec['owns'],
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left)
    .filter((k) => (left[k] ?? []).length > 0)
    .sort();
  const rightKeys = Object.keys(right)
    .filter((k) => (right[k as keyof typeof right] ?? []).length > 0)
    .sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i += 1) {
    if (leftKeys[i] !== rightKeys[i]) return false;
    const key = leftKeys[i];
    const l = [...(left[key] ?? [])].sort();
    const r = [...(right[key as keyof typeof right] ?? [])].sort();
    if (l.length !== r.length) return false;
    if (l.some((v, j) => v !== r[j])) return false;
  }
  return true;
}

/** True when the materialized row already matches the manifest entry exactly. */
function rowMatchesSpec(row: ProjectCraftRow, spec: CraftEntrySpec): boolean {
  return (
    (row.repoOwner ?? null) === spec.repoOwner &&
    (row.repoName ?? null) === spec.repoName &&
    (row.gitRef ?? null) === spec.gitRef &&
    (row.resolvedSha ?? null) === spec.resolvedSha &&
    (row.title ?? null) === spec.title &&
    ownsEqual(row.owns, spec.owns)
  );
}

/**
 * Reconcile `project_crafts` from one successfully parsed manifest.
 *
 * The same contract as `reconcileProjectTriggerRuntimeWithStore`, and for the
 * same reason: the manifest is the source of truth, this table is a projection,
 * and the projection must converge on every read path so a hand-edited
 * `kortix.yaml` or a raw git push heals within one sweep.
 *
 * The caller MUST NOT call this when the manifest is unreadable. A transient
 * git failure must never be read as "this project has no crafts" — that would
 * delete every installed craft's row and orphan its run history.
 *
 * `pruneStale: false` is the non-destructive form for GET paths, where another
 * API task can briefly observe an older git checkout.
 */
export async function reconcileProjectCraftsWithStore(
  projectId: string,
  specs: readonly CraftEntrySpec[],
  store: ProjectCraftCatalogStore,
  options: { pruneStale?: boolean } = {},
): Promise<{ upserted: number; removed: number }> {
  const existing = await store.list(projectId);
  const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
  const declaredSlugs = new Set(specs.map((spec) => spec.slug));
  let upserted = 0;

  for (const spec of specs) {
    const current = existingBySlug.get(spec.slug);
    // Write only on a real difference. A craft's row is read on every project
    // page, and an unconditional upsert would bump `updated_at` on every sweep
    // for every project, making "when did this craft last change" meaningless.
    if (!current || !rowMatchesSpec(current, spec)) {
      await store.upsert(projectId, spec);
      upserted += 1;
    }
  }

  const stale =
    options.pruneStale === false ? [] : existing.filter((row) => !declaredSlugs.has(row.slug));
  for (const row of stale) {
    await store.remove(projectId, row.slug);
  }

  return { upserted, removed: stale.length };
}
