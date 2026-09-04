// WHICH SUBPROJECTS MAY THIS CALLER SEE.
//
// A subproject is an IAM object, closed by default (`object_policies` row
// `subproject = closed`), exactly like an agent. Manager tier — account
// owner/admin, project manager, service account, super-admin — sees every
// subproject; a member sees only the ones with a grant row naming them or one
// of their groups. Zero grant rows therefore means zero subprojects for a
// member, which is the whole point of the closed default.
//
// The verdict comes from `filterAccessibleObjects`, the SAME fold the agent
// picker and the agent gate use, so what the UI lists and what the server
// accepts cannot drift. Nothing here re-derives "who bypasses".

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { filterAccessibleObjects } from '../../iam/authorize';
import { actorOf } from '../../iam/actor';
import { withProjectGitAuth } from './git';
import { loadProjectSubprojects, type SubprojectSessionsMode } from '../subprojects';
import type { ProjectRow } from './serializers';

interface LoadedProject {
  row: ProjectRow;
  userId: string;
}

/**
 * Of `slugs`, the ones this caller may use. Preserves input order, one memoized
 * grant load for the whole list. An empty input short-circuits with no I/O.
 */
export async function accessibleSubprojectSlugs(
  c: Context,
  loaded: LoadedProject,
  projectId: string,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const actor = await actorOf(c, loaded.row.accountId);
  return filterAccessibleObjects(actor, projectId, 'subproject', slugs);
}

/** The 403 for a subproject the caller may not use. `code` +
 *  `accessible_subprojects` let a client recover by picking a usable one —
 *  the same shape `agent-access.ts` returns for an agent denial. */
export function subprojectDenial(slug: string, accessible: string[]): HTTPException {
  const message = accessible.length
    ? `You don't have access to the ${slug} subproject — pick one of: ${accessible.join(', ')}.`
    : `You don't have access to the ${slug} subproject. Ask a manager to grant it to you.`;
  return new HTTPException(403, {
    message,
    res: new Response(
      JSON.stringify({
        error: message,
        message,
        code: 'subproject_not_accessible',
        accessible_subprojects: accessible,
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  });
}

/**
 * Assert this caller may use `slug`, or throw the 403 they can act on.
 * `declaredSlugs` is the project's full declared set — it seeds the
 * `accessible_subprojects` hint so the denial names what they COULD pick.
 */
export async function assertSubprojectAccessible(
  c: Context,
  loaded: LoadedProject,
  projectId: string,
  slug: string,
  declaredSlugs: readonly string[] = [slug],
): Promise<void> {
  const candidates = [...new Set([slug, ...declaredSlugs])];
  const accessible = await accessibleSubprojectSlugs(c, loaded, projectId, candidates);
  if (accessible.includes(slug)) return;
  throw subprojectDenial(
    slug,
    accessible.filter((s) => s !== slug),
  );
}

/** What the session inventory needs to fold subproject rows: which slugs the
 *  viewer may see, and which of them share their sessions. */
export interface SubprojectViewerAccess {
  accessible: Set<string>;
  /** Declared subprojects whose `sessions:` mode is `shared`. */
  shared: Set<string>;
}

/**
 * Resolve both halves for a set of slugs observed on session rows.
 *
 * The manifest read only happens because of the `shared` half, and this is
 * called only when some row actually carries a subproject — an ordinary project
 * pays nothing. A slug that is no longer declared (its block was deleted) keeps
 * whatever grant verdict it has: a manager still sees the historical rows, a
 * member without a grant does not, which is the documented delete behavior.
 */
export async function subprojectViewerAccess(
  c: Context,
  loaded: LoadedProject,
  projectId: string,
  slugs: readonly string[],
): Promise<SubprojectViewerAccess> {
  if (slugs.length === 0) return { accessible: new Set(), shared: new Set() };
  const [accessible, declared] = await Promise.all([
    accessibleSubprojectSlugs(c, loaded, projectId, slugs),
    loadSubprojectModes(loaded.row),
  ]);
  const shared = new Set<string>();
  for (const slug of slugs) {
    if (declared.get(slug) === 'shared') shared.add(slug);
  }
  return { accessible: new Set(accessible), shared };
}

/** slug → `sessions:` mode, straight from the manifest. Never throws: an
 *  unreadable manifest yields an empty map, i.e. every subproject behaves as
 *  `private` — the fail-closed direction. */
export async function loadSubprojectModes(
  project: ProjectRow,
): Promise<Map<string, SubprojectSessionsMode>> {
  try {
    const gitProject = await withProjectGitAuth(project);
    const loaded = await loadProjectSubprojects(gitProject);
    return new Map(loaded.specs.map((spec) => [spec.slug, spec.sessions]));
  } catch {
    return new Map();
  }
}
