import { triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

export interface TriggerRuntimeCatalogStore {
  list(
    workspaceId: string,
  ): Promise<Array<{ slug: string; sessionId?: string | null; scheduleRevision?: string | null }>>;
  upsert(workspaceId: string, spec: GitTriggerSpec, scheduleRevision: string): Promise<void>;
  remove(workspaceId: string, slug: string): Promise<void>;
}

/**
 * Reconcile runtime catalog rows from one successfully parsed manifest.
 *
 * The caller must not call this function when the manifest is unreadable.
 * A transient git failure must not delete valid runtime rows.
 */
export async function reconcileWorkspaceTriggerRuntimeWithStore(
  workspaceId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore,
): Promise<{ upserted: number; removed: number }> {
  const existing = await store.list(workspaceId);
  const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
  const declaredSlugs = new Set(specs.map((spec) => spec.slug));
  let upserted = 0;

  for (const spec of specs) {
    const current = existingBySlug.get(spec.slug);
    const scheduleRevision = triggerScheduleRevision(spec);
    if (
      !current ||
      (current.sessionId ?? null) !== spec.pinnedSessionId ||
      current.scheduleRevision !== scheduleRevision
    ) {
      await store.upsert(workspaceId, spec, scheduleRevision);
      upserted += 1;
    }
  }

  const stale = existing.filter((row) => !declaredSlugs.has(row.slug));
  for (const row of stale) {
    await store.remove(workspaceId, row.slug);
  }

  return { upserted, removed: stale.length };
}
