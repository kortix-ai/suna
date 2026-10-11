/**
 * The gate every App route runs: project membership, the App permission, the
 * `apps` flag, then the App's own visibility and the capability the route
 * needs. Shared by ./routes.ts and ./capability-routes.ts.
 */
import { apps } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../iam';
import { assertProjectCapability, loadProjectForUser } from '../projects/surface';
import type { AppEnv } from '../types';
import { requireFeatureFlag } from '../feature-flags/gate';
import { db } from '../shared/db';
import { appVisibleToUser } from './access';
import { type AppCapability, type AppHostingType, appCapabilities, capabilityUnsupportedBody } from './kinds';

/**
 * The App permission a route needs. Apps own these leaves outright — they no
 * longer borrow project.customize.write / project.gitops.read, so a custom role
 * can grant or revoke Apps without touching any other capability.
 *   read    list and inspect Apps, connect, mint a member token
 *   write   create, rename, resize, set access, snapshot, read logs
 *   deploy  ship a version, roll back, start, stop
 *   admin   reveal or rotate admin credentials, restore, delete a `convex` App
 */
export type AppPermission = 'read' | 'write' | 'deploy' | 'admin';

const APP_PERMISSION_ACTION: Record<AppPermission, string> = {
  read: PROJECT_ACTIONS.PROJECT_APP_READ,
  write: PROJECT_ACTIONS.PROJECT_APP_WRITE,
  deploy: PROJECT_ACTIONS.PROJECT_APP_DEPLOY,
  admin: PROJECT_ACTIONS.PROJECT_APP_ADMIN,
};

/**
 * Membership + permission + `apps` flag, in that order. Returns the loaded
 * project on success, or the Response the route must return:
 *   • 404 — the project does not exist or the caller is not a member (a
 *     non-member must not be able to distinguish the two).
 *   • 403 `feature_disabled` — the caller IS a member, but the project has the
 *     `apps` flag off. A member already knows the project exists, so the honest
 *     "turn it on in Settings" answer beats a misleading 404.
 * A permission denial still throws (403) from assertProjectCapability.
 */
export async function authorizedProject(c: Context<AppEnv>, projectId: string, permission: AppPermission = 'read') {
  const loaded = await loadProjectForUser(c, projectId, permission === 'read' ? 'read' : 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, APP_PERMISSION_ACTION[permission]);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'apps');
  if (gate) return gate;
  return loaded;
}

/** A live App of the project, whoever asks. */
export async function scopedApp(projectId: string, appId: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.appId, appId), eq(apps.projectId, projectId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The App a caller may act on, or null. Holding project.app.read is necessary
 * but not sufficient: the App access policy decides WHICH Apps in the project
 * the caller sees (see appVisibleToUser). An App the caller cannot see answers
 * 404, never 403 — a member must not learn that a teammate's private App
 * exists from the status code.
 */
export async function visibleApp(projectId: string, appId: string, userId: string) {
  const row = await scopedApp(projectId, appId);
  if (!row) return null;
  return (await appVisibleToUser(row, userId)) ? row : null;
}

/** 409 `app_capability_unsupported` when the App lacks `capability`, else null. */
export function capabilityRefusal(
  c: Context<AppEnv>,
  app: { kind: string },
  capability: AppCapability,
  hostingType: AppHostingType | null = null,
) {
  if (appCapabilities(app, hostingType).includes(capability)) return null;
  return c.json(capabilityUnsupportedBody(app, capability), 409);
}
