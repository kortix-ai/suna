import { triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

export interface TriggerRuntimeCatalogStore {
  list(
    projectId: string,
  ): Promise<Array<{ slug: string; sessionId?: string | null; scheduleRevision?: string | null }>>;
  upsert(projectId: string, spec: GitTriggerSpec, scheduleRevision: string): Promise<void>;
  remove(projectId: string, slug: string): Promise<void>;
  /**
   * The subset of `sessionIds` that are sessions of `projectId`. A pinned
   * `session_id` is manifest text; a value outside the project is recorded as
   * no pin. Optional so an in-memory store can omit it.
   */
  sessionsOfProject?(projectId: string, sessionIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/**
 * Drop every pinned session id that is not a session of this project. The
 * runtime catalog then never names a foreign session, and a later fire takes
 * the trigger's own reuse/create path.
 */
async function withProjectPins(
  projectId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore,
): Promise<readonly GitTriggerSpec[]> {
  if (!store.sessionsOfProject) return specs;
  const pinned = [...new Set(specs.flatMap((spec) => (spec.pinnedSessionId ? [spec.pinnedSessionId] : [])))];
  if (pinned.length === 0) return specs;
  const owned = await store.sessionsOfProject(projectId, pinned);
  return specs.map((spec) =>
    spec.pinnedSessionId && !owned.has(spec.pinnedSessionId) ? { ...spec, pinnedSessionId: null } : spec,
  );
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
  specs = await withProjectPins(projectId, specs, store);
  const existing = await store.list(projectId);
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
      await store.upsert(projectId, spec, scheduleRevision);
      upserted += 1;
    }
  }

  const stale =
    options.pruneStale === false
      ? []
      : existing.filter((row) => !declaredSlugs.has(row.slug));
  for (const row of stale) {
    await store.remove(projectId, row.slug);
  }

  return { upserted, removed: stale.length };
}
