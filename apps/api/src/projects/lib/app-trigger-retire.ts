/**
 * An App and the triggers that name it retire together. A trigger names an App
 * when the App's events fire it (`on: { event, app }`) or a fire calls the App
 * (`run: { app, path }`). Without the App neither works again: a call fails on
 * every fire, and a silence window (`expect_event_within`) raises an alert
 * that no event can clear. So an App delete removes them in the same request:
 * the kortix.yaml ones in the commit that removes the App's block, the runtime
 * agent triggers (`kortix triggers add`) from the trigger table.
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { extractTriggers, type GitTriggerSpec, type ParsedManifest } from '../triggers';
import { isRuntimeTriggerSlug } from './runtime-triggers';
import { removeTriggerFromManifest } from './trigger-manifest';
import { deleteTriggerWatchers } from './trigger-watchers';

/** Whether a trigger names the App `slug`: its events fire it, or it calls the App. Pure. */
export function triggerNamesApp(spec: Pick<GitTriggerSpec, 'app' | 'target'>, slug: string): boolean {
  return spec.app === slug || spec.target?.app === slug;
}

/** The manifest without the triggers that name the App `slug`, and their slugs. Pure. */
export function withoutAppTriggers(manifest: ParsedManifest, slug: string): { manifest: ParsedManifest; removed: string[] } {
  const removed = extractTriggers(manifest).specs.filter((spec) => triggerNamesApp(spec, slug)).map((spec) => spec.slug).sort();
  const next = removed.reduce((current, trigger) => removeTriggerFromManifest(current, trigger), manifest);
  return { manifest: next, removed };
}

/**
 * The project's runtime triggers (ids like `trigger.<hex>`) that name the App
 * `slug`. A session trigger (a wake-on pinned to a session) is its session's,
 * not the project's: only a caller who can open that session may remove it,
 * so an App delete leaves it to its owner. With the App gone it never fires,
 * and the silence check skips it.
 */
export async function runtimeTriggersNamingApp(projectId: string, slug: string): Promise<string[]> {
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug })
    .from(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, projectId),
      // A kortix.yaml slug has no `.`; those rows belong to the manifest commit.
      like(projectTriggerRuntime.slug, '%.%'),
      isNull(projectTriggerRuntime.sessionId),
      sql`${projectTriggerRuntime.scheduleSpec} ->> 'pinnedSessionId' is null`,
      sql`${projectTriggerRuntime.scheduleSpec} ->> 'reminder' is null`,
      or(
        sql`${projectTriggerRuntime.scheduleSpec} ->> 'app' = ${slug}`,
        sql`${projectTriggerRuntime.scheduleSpec} -> 'target' ->> 'app' = ${slug}`,
      ),
    ));
  return rows.map((row) => row.slug).filter(isRuntimeTriggerSlug).sort();
}

/**
 * Drop the trigger rows and watchers of the triggers an App delete removed:
 * the kortix.yaml ones its commit took out, and the runtime ones. What the
 * trigger delete route does for one trigger, for each of them.
 */
export async function dropRetiredAppTriggers(projectId: string, slugs: readonly string[]): Promise<void> {
  if (slugs.length === 0) return;
  await db.delete(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), inArray(projectTriggerRuntime.slug, [...slugs])));
  for (const slug of slugs) {
    await deleteTriggerWatchers({ projectId, slug }).catch((error) =>
      logger.warn('[app-trigger-retire] watcher cleanup failed', { projectId, slug, error: String(error) }));
  }
}
