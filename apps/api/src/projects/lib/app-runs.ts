/**
 * One-off App runs (`runAfter` / `runAt`): an App asks Kortix to call it later.
 *
 * A run is a `project_trigger_runtime` row like a session reminder: never in
 * kortix.yaml, slug `apprun.<hex>` (a manifest slug has no `.`, so the catalog
 * never prunes it), a one-off `run_at` and `target: { app, path, method, payload }`.
 * The trigger scheduler claims and fires it like any cron row, and the fire
 * calls the App (lib/trigger-fire.ts). A fired run is purged after 30 days.
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNotNull, isNull, like, lt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../shared/db';
import type { GitTriggerSpec } from '../triggers';
import { triggerScheduleRevision } from '../trigger-schedule';

export const APP_RUN_SLUG_PREFIX = 'apprun.';
export const MAX_PENDING_APP_RUNS = 1000;
export const APP_RUN_RETENTION_DAYS = 30;

const pendingOf = (projectId: string, app: string) => and(
  eq(projectTriggerRuntime.projectId, projectId),
  like(projectTriggerRuntime.slug, `${APP_RUN_SLUG_PREFIX}%`),
  isNotNull(projectTriggerRuntime.nextFireAt),
  sql`${projectTriggerRuntime.scheduleSpec} -> 'target' ->> 'app' = ${app}`,
);

export async function insertAppRun(input: {
  projectId: string;
  app: string;
  runAt: Date;
  method: 'POST' | 'GET';
  path: string;
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<{ runId: string; runAt: Date } | { error: string }> {
  const now = input.now ?? new Date();
  const slug = `${APP_RUN_SLUG_PREFIX}${randomBytes(8).toString('hex')}`;
  const spec: GitTriggerSpec = {
    slug, path: `apps.${input.app}#runs`, name: `Run of ${input.app}`, type: 'cron', agent: 'default', model: null, enabled: true,
    promptTemplate: '', cron: null, runAt: input.runAt.toISOString(), timezone: 'UTC', secretEnv: null,
    sessionMode: 'fresh', pinnedSessionId: null,
    sessionKey: null, filter: null, target: { app: input.app, path: input.path, method: input.method, payload: input.payload },
  };
  return db.transaction(async (tx) => {
    // Count and insert under one lock, or parallel creates all read the same count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`app-runs:${input.projectId}:${input.app}`}, 0))`);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(projectTriggerRuntime).where(pendingOf(input.projectId, input.app));
    if ((count?.n ?? 0) >= MAX_PENDING_APP_RUNS) return { error: `An App holds at most ${MAX_PENDING_APP_RUNS} pending runs.` };
    await tx.insert(projectTriggerRuntime).values({
      projectId: input.projectId, slug, triggerType: 'cron', enabled: true, scheduleCron: null, scheduleRunAt: input.runAt,
      scheduleTimezone: 'UTC', scheduleRevision: triggerScheduleRevision(spec), scheduleSpec: spec as unknown as Record<string, unknown>,
      nextFireAt: input.runAt, updatedAt: now,
    });
    return { runId: slug, runAt: input.runAt };
  });
}

/** Cancel a pending run of this App. False when it has fired, or is not this App's. */
export async function cancelAppRun(projectId: string, app: string, runId: string): Promise<boolean> {
  if (!runId.startsWith(APP_RUN_SLUG_PREFIX)) return false;
  const rows = await db.delete(projectTriggerRuntime)
    .where(and(pendingOf(projectId, app), eq(projectTriggerRuntime.slug, runId)))
    .returning({ slug: projectTriggerRuntime.slug });
  return rows.length > 0;
}

/** Delete fired runs past retention, bounded per pass. */
export async function purgeFiredAppRuns(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - APP_RUN_RETENTION_DAYS * 86_400_000);
  const rows = await db.delete(projectTriggerRuntime)
    .where(sql`(${projectTriggerRuntime.projectId}, ${projectTriggerRuntime.slug}) in (
      select ${projectTriggerRuntime.projectId}, ${projectTriggerRuntime.slug} from ${projectTriggerRuntime}
      where ${and(like(projectTriggerRuntime.slug, `${APP_RUN_SLUG_PREFIX}%`), isNull(projectTriggerRuntime.nextFireAt), lt(projectTriggerRuntime.updatedAt, cutoff))}
      limit 5000)`)
    .returning({ slug: projectTriggerRuntime.slug });
  return rows.length;
}
