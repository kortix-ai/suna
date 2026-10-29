/**
 * The Apps of a channel: live Apps of the project with a deployment made from
 * a thread of that channel (`app_deployments.source_session_id` →
 * `project_sessions.space_id`). Derived, nothing stored. An App never
 * deployed from a thread is in no channel.
 */
import { appDeployments, apps, projectSessions } from '@kortix/db';
import { and, desc, eq, exists, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { appsOpenableByUser, filterAppsVisibleToUser } from './access';

type AppRow = typeof apps.$inferSelect;

/**
 * The rows the caller may see AND open, and the openable set `appsJson`
 * takes. The project Apps list and a channel's Apps both filter through it:
 * no card that is listed and then refuses to open.
 */
export async function accessibleApps(rows: AppRow[], userId: string) {
  const visible = await filterAppsVisibleToUser(rows, userId);
  const openable = await appsOpenableByUser(visible, userId);
  return { rows: visible.filter((row) => openable.has(row.appId)), openable };
}

/** The channel's Apps the caller may open, newest first. */
export async function spaceApps(projectId: string, spaceId: string, userId: string) {
  const fromSpace = db
    .select({ one: sql`1` })
    .from(appDeployments)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, appDeployments.sourceSessionId))
    .where(and(eq(appDeployments.appId, apps.appId), eq(projectSessions.spaceId, spaceId)));
  const rows = await db
    .select()
    .from(apps)
    .where(and(eq(apps.projectId, projectId), isNull(apps.deletedAt), exists(fromSpace)))
    .orderBy(desc(apps.createdAt));
  return accessibleApps(rows, userId);
}
