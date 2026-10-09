/**
 * App links: an App `uses` other Apps of its project (`kortix.yaml`
 * `apps.<name>.uses`). A link lets the using App mint sign-in tokens for the
 * used one (`/_kortix/token?audience=`) and reach it through its bindings
 * mount (`/_kortix/apps/<slug>/*`). Rows cascade with either App.
 */
import { appLinks, apps } from '@kortix/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../shared/db';

export interface AppLinkSlugs {
  uses: string[];
  usedBy: string[];
}

/** The live linked Apps of each App, by slug, in one query. */
export async function appLinkSlugs(appIds: string[]): Promise<Map<string, AppLinkSlugs>> {
  const out = new Map<string, AppLinkSlugs>(appIds.map((id) => [id, { uses: [], usedBy: [] }]));
  if (appIds.length === 0) return out;
  const rows = await db
    .select({ appId: appLinks.appId, usesAppId: appLinks.usesAppId, slug: apps.slug, otherId: apps.appId })
    .from(appLinks)
    .innerJoin(apps, or(eq(apps.appId, appLinks.appId), eq(apps.appId, appLinks.usesAppId)))
    .where(and(or(inArray(appLinks.appId, appIds), inArray(appLinks.usesAppId, appIds)), isNull(apps.deletedAt)));
  for (const row of rows) {
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
 * Replaces the Apps `appId` uses with the live Apps of its project named
 * `slugs`. Throws UnknownLinkedAppError (nothing changed) for a slug no live
 * App has, or for the App itself.
 */
export async function setAppLinks(app: { appId: string; projectId: string; slug: string }, slugs: string[]): Promise<void> {
  const wanted = [...new Set(slugs)];
  const found = wanted.length
    ? await db
        .select({ appId: apps.appId, slug: apps.slug })
        .from(apps)
        .where(and(eq(apps.projectId, app.projectId), inArray(apps.slug, wanted), isNull(apps.deletedAt)))
    : [];
  const missing = wanted.filter((slug) => slug === app.slug || !found.some((row) => row.slug === slug));
  if (missing.length) throw new UnknownLinkedAppError(missing);
  await db.transaction(async (tx) => {
    await tx.delete(appLinks).where(eq(appLinks.appId, app.appId));
    if (found.length) await tx.insert(appLinks).values(found.map((row) => ({ appId: app.appId, usesAppId: row.appId })));
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The live App of the project that `appId` uses, named by slug or by App id, or null. */
export async function linkedApp(appId: string, projectId: string, slugOrId: string) {
  const [row] = await db
    .select({ appId: apps.appId, kind: apps.kind, slug: apps.slug })
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
