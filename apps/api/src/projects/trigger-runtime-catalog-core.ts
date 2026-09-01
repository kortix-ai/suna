import { triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

export interface TriggerRuntimeCatalogStore {
  list(projectId: string): Promise<
    Array<{
      slug: string;
      sessionId?: string | null;
      subprojectSlug?: string | null;
      scheduleRevision?: string | null;
    }>
  >;
  upsert(projectId: string, spec: GitTriggerSpec, scheduleRevision: string): Promise<void>;
  remove(projectId: string, slug: string): Promise<void>;
}

/**
 * Reconcile runtime catalog rows from one successfully parsed manifest.
 *
 * The caller must not call this function when the manifest is unreadable.
 * A transient git failure must not delete valid runtime rows.
 */
export async function reconcileProjectTriggerRuntimeWithStore(
  projectId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore,
  options: { pruneStale?: boolean } = {},
): Promise<{ upserted: number; removed: number }> {
  const existing = await store.list(projectId);
  const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
  const declaredSlugs = new Set(specs.map((spec) => spec.slug));
  let upserted = 0;

  for (const spec of specs) {
    const current = existingBySlug.get(spec.slug);
    const scheduleRevision = triggerScheduleRevision(spec);
    // `subprojectSlug` is part of the comparison, not just the written row: a
    // manifest edit that only adds or removes `subproject:` changes neither the
    // pinned session nor the schedule revision, so without it here the
    // ownership column would silently never be materialized — and the subproject's
    // run history would stay empty while its triggers fired normally.
    if (
      !current ||
      (current.sessionId ?? null) !== spec.pinnedSessionId ||
      (current.subprojectSlug ?? null) !== spec.subprojectSlug ||
      current.scheduleRevision !== scheduleRevision
    ) {
      await store.upsert(projectId, spec, scheduleRevision);
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
