import { projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type TriggerRuntimeCatalogStore,
  reconcileProjectTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';
import { initialTriggerScheduleSlot } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

const databaseStore: TriggerRuntimeCatalogStore = {
  async list(projectId) {
    return db
      .select({
        slug: projectTriggerRuntime.slug,
        sessionId: projectTriggerRuntime.sessionId,
        craftSlug: projectTriggerRuntime.craftSlug,
        scheduleRevision: projectTriggerRuntime.scheduleRevision,
      })
      .from(projectTriggerRuntime)
      .where(eq(projectTriggerRuntime.projectId, projectId));
  },

  async upsert(projectId, spec, scheduleRevision) {
    const now = new Date();
    // A monitor is cataloged like any other trigger (its full spec lands in
    // `schedule_spec`, which the observer reads), but it has no schedule:
    // `initialTriggerScheduleSlot` returns null for every non-cron type, so
    // `next_fire_at` stays NULL and `claimDueScheduleSlots` — which filters
    // `trigger_type = 'cron'` — can never claim it.
    // Jittered by (project, slug): identical manifests across projects share a
    // cron expression, and an unjittered fleet fires as one burst.
    const nextFireAt = initialTriggerScheduleSlot(spec, now, {
      jitterKey: `${projectId}:${spec.slug}`,
    });
    await db
      .insert(projectTriggerRuntime)
      .values({
        projectId,
        slug: spec.slug,
        sessionId: spec.pinnedSessionId,
        craftSlug: spec.craftSlug,
        triggerType: spec.type,
        enabled: spec.enabled,
        scheduleCron: spec.cron,
        scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
        scheduleTimezone: spec.timezone,
        scheduleRevision,
        scheduleSpec: spec as unknown as Record<string, unknown>,
        nextFireAt,
        lastScheduledFor: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
        set: {
          sessionId: spec.pinnedSessionId,
          // Re-materialized on every reconcile, so removing `craft:` from the
          // manifest clears the column and the craft's run history stops
          // claiming the trigger. Ownership can only be changed in git.
          craftSlug: spec.craftSlug,
          triggerType: spec.type,
          enabled: spec.enabled,
          scheduleCron: spec.cron,
          scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
          scheduleTimezone: spec.timezone,
          scheduleRevision,
          scheduleSpec: spec as unknown as Record<string, unknown>,
          nextFireAt,
          lastScheduledFor: null,
          updatedAt: now,
        },
      });
  },

  async remove(projectId, slug) {
    await db
      .delete(projectTriggerRuntime)
      .where(
        and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
      );
  },
};

export async function reconcileProjectTriggerRuntime(
  projectId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectTriggerRuntimeWithStore(projectId, specs, store);
}

/**
 * Ensure every trigger visible in one manifest read has runtime state without
 * deleting rows absent from that read. GET requests use this non-destructive
 * form because another API task can briefly observe an older git checkout
 * immediately after a manifest write. Treating that stale snapshot as
 * authoritative used to delete the new trigger's runtime row and cascade its
 * session-access grants back to the private default.
 */
export async function ensureProjectTriggerRuntime(
  projectId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectTriggerRuntimeWithStore(projectId, specs, store, { pruneStale: false });
}

export type { TriggerRuntimeCatalogStore } from './trigger-runtime-catalog-core';
