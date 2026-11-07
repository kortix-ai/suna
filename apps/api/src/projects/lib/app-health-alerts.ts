/**
 * Crash alerts of an always-on App. Keep-alive (apps/idle-reaper.ts) starts a
 * stopped App supervisor again at most 3 times an hour; past that the App
 * stays down until someone acts. Then every enabled `type: app` trigger that
 * names the App opens a `crash` streak (its watchers hear it once), and
 * `kortix.app.crashed` goes to the App's log for a repair trigger. The next
 * keep-alive pass that finds the App running ends the streaks and writes
 * `kortix.app.recovered`.
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { emitAppPlatformEvent, isAppPlatformEvent } from './app-events';
import { clearTriggerAlert, raiseTriggerHealthAlert } from './trigger-alerts';

const namesApp = (appSlug: string) => sql`${projectTriggerRuntime.scheduleSpec} ->> 'app' = ${appSlug}`;

/** The alert body: what stopped, what Kortix did, where to look. Pure. */
export function crashMessage(appSlug: string, restarts: number): string {
  return (
    `App "${appSlug}" stopped ${restarts} times in an hour, and Kortix stopped restarting it. ` +
    `Read why: kortix apps logs ${appSlug}. Fix it and deploy again: kortix apps deploy.`
  );
}

/**
 * Open a crash streak on each trigger that names the App and write
 * `kortix.app.crashed` once per episode. The episode is the open crash
 * alert's start, which is durable, so a new scheduler leader writes no second
 * event for the same crash; `episode` is the fallback for an App with no work
 * trigger. A trigger that listens to a `kortix.app.*` event is the repair,
 * not the work: it gets the event, not an alert. Returns the alerts raised.
 */
export async function raiseAppCrashAlerts(input: {
  projectId: string;
  appSlug: string;
  episode: string;
  restarts: number;
  now?: Date;
}): Promise<number> {
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug, enabled: projectTriggerRuntime.enabled, scheduleSpec: projectTriggerRuntime.scheduleSpec })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.triggerType, 'app'), namesApp(input.appSlug)));
  const error = crashMessage(input.appSlug, input.restarts);
  let raised = 0;
  for (const row of rows) {
    const event = (row.scheduleSpec as { filter?: Record<string, unknown> | null } | null)?.filter?.['event.name'];
    if (row.enabled === false || (typeof event === 'string' && isAppPlatformEvent(event))) continue;
    if (await raiseTriggerHealthAlert({ projectId: input.projectId, slug: row.slug, error, source: 'crash' })) raised += 1;
  }
  const [open] = await db
    .select({ since: sql<Date | string | null>`min(${projectTriggerRuntime.alertFailingSince})` })
    .from(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, input.projectId),
      eq(projectTriggerRuntime.triggerType, 'app'),
      eq(projectTriggerRuntime.alertSource, 'crash'),
      namesApp(input.appSlug),
    ));
  const since = open?.since ? new Date(open.since).getTime() : null;
  const episode = since !== null ? `${input.appSlug}:${since}` : input.episode;
  await emitAppPlatformEvent({
    projectId: input.projectId, appSlug: input.appSlug, name: 'kortix.app.crashed', id: `crashed:${episode}`,
    data: { restarts: input.restarts, within_seconds: 3600 }, now: input.now,
  });
  return raised;
}

/**
 * End the App's crash streaks and, when it runs again, write
 * `kortix.app.recovered` once. A person who stops the App ends them too
 * (`running: false`): nothing will run it again, so nothing would clear them.
 * Returns the streaks ended.
 */
export async function clearAppCrashAlerts(input: { projectId: string; appSlug: string; now?: Date; running?: boolean }): Promise<number> {
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug })
    .from(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, input.projectId),
      eq(projectTriggerRuntime.triggerType, 'app'),
      eq(projectTriggerRuntime.alertSource, 'crash'),
      namesApp(input.appSlug),
    ));
  let cleared = 0;
  for (const row of rows) {
    if (await clearTriggerAlert({ projectId: input.projectId, slug: row.slug, source: 'crash' })) cleared += 1;
  }
  if (cleared > 0 && input.running !== false) {
    const now = input.now ?? new Date();
    await emitAppPlatformEvent({
      projectId: input.projectId, appSlug: input.appSlug, name: 'kortix.app.recovered', id: `recovered:crash:${input.appSlug}:${now.getTime()}`,
      data: { cause: 'crash' }, now,
    });
  }
  return cleared;
}
