import type { GitTriggerSpec } from './triggers';

export interface TriggerRuntimeCatalogStore {
  list(projectId: string): Promise<Array<{ slug: string; sessionId?: string | null }>>;
  upsert(projectId: string, spec: GitTriggerSpec): Promise<void>;
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
): Promise<{ upserted: number; removed: number }> {
  const existing = await store.list(projectId);
  const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
  const declaredSlugs = new Set(specs.map((spec) => spec.slug));
  let upserted = 0;

  for (const spec of specs) {
    const current = existingBySlug.get(spec.slug);
    if (!current || (current.sessionId ?? null) !== spec.pinnedSessionId) {
      await store.upsert(projectId, spec);
      upserted += 1;
    }
  }

  const stale = existing.filter((row) => !declaredSlugs.has(row.slug));
  for (const row of stale) {
    await store.remove(projectId, row.slug);
  }

  return { upserted, removed: stale.length };
}
