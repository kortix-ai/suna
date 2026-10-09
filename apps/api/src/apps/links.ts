/**
 * App links: an App `uses` other Apps of its project (`kortix.yaml`
 * `apps.<name>.uses`). A link lets the using App mint sign-in tokens for the
 * used one (`/_kortix/token?audience=`) and reach it through its bindings
 * mount (`/_kortix/apps/<slug>/*`). Rows cascade with either App.
 *
 * Links never cross App visibility: a caller links only Apps they can see,
 * and an App's `uses` / `used_by` list only the linked Apps the reader can
 * see, so a private App's slug never leaks through a link.
 */
import { appLinks, apps } from '@kortix/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../shared/db';
import { filterAppsVisibleToUser } from './access';

export interface AppLinkSlugs {
  uses: string[];
  usedBy: string[];
}

/** The live linked Apps of each App that `viewerId` can see, by slug. `appIds` belong to one project. */
export async function appLinkSlugs(appIds: string[], viewerId: string): Promise<Map<string, AppLinkSlugs>> {
  const out = new Map<string, AppLinkSlugs>(appIds.map((id) => [id, { uses: [], usedBy: [] }]));
  if (appIds.length === 0) return out;
  const rows = await db
    .select({
      appId: appLinks.appId,
      usesAppId: appLinks.usesAppId,
      slug: apps.slug,
      otherId: apps.appId,
      accountId: apps.accountId,
      projectId: apps.projectId,
      accessMode: apps.accessMode,
      createdBy: apps.createdBy,
    })
    .from(appLinks)
    .innerJoin(apps, or(eq(apps.appId, appLinks.appId), eq(apps.appId, appLinks.usesAppId)))
    .where(and(or(inArray(appLinks.appId, appIds), inArray(appLinks.usesAppId, appIds)), isNull(apps.deletedAt)));
  const others = [...new Map(rows.map((row) => [row.otherId, { ...row, appId: row.otherId }])).values()];
  const visible = new Set((await filterAppsVisibleToUser(others, viewerId)).map((row) => row.appId));
  for (const row of rows) {
    if (!visible.has(row.otherId)) continue;
    // Each link joins twice (once per end); keep the end that is the OTHER App.
    if (row.otherId === row.usesAppId) out.get(row.appId)?.uses.push(row.slug);
    if (row.otherId === row.appId) out.get(row.usesAppId)?.usedBy.push(row.slug);
  }
  for (const links of out.values()) {
    links.uses.sort();
    links.usedBy.sort();
  }
  return out;
}

export class UnknownLinkedAppError extends Error {
  constructor(readonly slugs: string[]) {
    super(`no App named ${slugs.map((s) => `"${s}"`).join(', ')} in this project`);
  }
}

/**
 * The live Apps of the project named `slugs` that `userId` can see. Throws
 * UnknownLinkedAppError for a slug no such App has, or for the App itself.
 * An App the caller cannot see answers exactly like a missing one, so the
 * error is no oracle for private slugs. Writes nothing.
 */
export async function resolveAppLinks(
  app: { projectId: string; slug: string },
  slugs: string[],
  userId: string,
): Promise<Array<{ appId: string; slug: string }>> {
  const wanted = [...new Set(slugs)];
  const rows = wanted.length
    ? await db
        .select({ appId: apps.appId, slug: apps.slug, accountId: apps.accountId, projectId: apps.projectId, accessMode: apps.accessMode, createdBy: apps.createdBy })
        .from(apps)
        .where(and(eq(apps.projectId, app.projectId), inArray(apps.slug, wanted), isNull(apps.deletedAt)))
    : [];
  const found = await filterAppsVisibleToUser(rows, userId);
  const missing = wanted.filter((slug) => slug === app.slug || !found.some((row) => row.slug === slug));
  if (missing.length) throw new UnknownLinkedAppError(missing);
  return found.map(({ appId, slug }) => ({ appId, slug }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Replaces the Apps `appId` uses with `found` (from {@link resolveAppLinks}), in `tx`. */
export async function writeAppLinks(tx: Tx, appId: string, found: Array<{ appId: string }>): Promise<void> {
  await tx.delete(appLinks).where(eq(appLinks.appId, appId));
  if (found.length) await tx.insert(appLinks).values(found.map((row) => ({ appId, usesAppId: row.appId })));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The live App of the project that `appId` uses, named by slug or by App id, or null. */
export async function linkedApp(appId: string, projectId: string, slugOrId: string) {
  const [row] = await db
    .select({ appId: apps.appId, kind: apps.kind, slug: apps.slug, accountId: apps.accountId, projectId: apps.projectId, accessMode: apps.accessMode, createdBy: apps.createdBy })
    .from(appLinks)
    .innerJoin(apps, eq(apps.appId, appLinks.usesAppId))
    .where(
      and(
        eq(appLinks.appId, appId),
        eq(apps.projectId, projectId),
        UUID.test(slugOrId) ? eq(apps.appId, slugOrId.toLowerCase()) : eq(apps.slug, slugOrId),
        isNull(apps.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
