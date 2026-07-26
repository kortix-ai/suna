/**
 * The prelude every AGI handler runs, in one place so the ordering cannot drift
 * between routes.
 *
 * Order is: membership floor (`loadProjectForUser`) → leaf capability
 * (`assertProjectCapability`) → the `agi` experimental gate. The feature check
 * is LAST, after authz, so a caller who cannot reach the project can never use
 * the response to learn which features that project has turned on — the same
 * ordering r4.ts documents for its channel gates.
 *
 * The gate answers 404, not 403: R-44 says that when `agi` is off there are no
 * routes, so the surface must not exist. The message is descriptive because a
 * caller reaching it has already proven membership.
 */
import { resolveExperimentalFeature } from '../experimental/features';
import { loadProjectForUser, assertProjectCapability } from '../projects/lib/access';
import type { ProjectAccessAction } from '../projects/access';
import type { Context } from 'hono';

export type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

export type AgiPrelude =
  | { ok: true; loaded: LoadedProject }
  | { ok: false; response: Response };

/**
 * `loadProjectForUser` returns null for a missing/archived project (404) and
 * THROWS HTTPException(403) for a non-member — the throw is deliberately not
 * caught here so a non-member gets the same 403 whether or not `agi` is on.
 */
export async function requireAgiProject(
  c: Context,
  projectId: string,
  floor: ProjectAccessAction,
  leaf: string,
): Promise<AgiPrelude> {
  const loaded = await loadProjectForUser(c, projectId, floor);
  if (!loaded) return { ok: false, response: c.json({ error: 'Not found' }, 404) };

  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, leaf);

  if (!resolveExperimentalFeature(loaded.row.metadata, 'agi')) {
    return { ok: false, response: c.json({ error: 'AGI is not enabled for this project' }, 404) };
  }
  return { ok: true, loaded };
}
