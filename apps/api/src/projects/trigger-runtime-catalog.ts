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
        scheduleRevision: projectTriggerRuntime.scheduleRevision,
      })
      .from(projectTriggerRuntime)
      .where(eq(projectTriggerRuntime.projectId, projectId));
  },

  async upsert(projectId, spec, scheduleRevision) {
    const now = new Date();
    const nextFireAt = initialTriggerScheduleSlot(spec, now);
    await db
      .insert(projectTriggerRuntime)
      .values({
        projectId,
        slug: spec.slug,
        sessionId: spec.pinnedSessionId,
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

export type { TriggerRuntimeCatalogStore } from './trigger-runtime-catalog-core';
