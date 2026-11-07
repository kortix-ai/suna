'use client';

import type { KortixProject } from '../core/rest/projects-client';
import { useProjectRow } from './use-project-row';

/**
 * The ONLY way to read a project's name.
 *
 * The two-titles bug was not an invalidation gap, it was two sources for one
 * fact: `project-switcher.tsx` read `activeProject?.name` off the projects
 * LIST and fell back to the detail, while `project-home.tsx` read the detail
 * alone. Any divergence between the two caches rendered as two different names
 * on one screen.
 *
 * One accessor makes that structurally impossible rather than merely currently
 * invalidated. Do not reintroduce a `??` fallback to another source here.
 *
 * The source is the bare project row (`qk.project.summary`, one database read),
 * not the detail, which reads the repository and can take seconds: the name in
 * the project shell must never wait on git.
 */
export function useWorkspaceName(projectId: string | undefined): string | undefined {
  const { data } = useProjectRow(projectId);
  return data?.name;
}

/** @deprecated Use `useWorkspaceName`. Kept permanently. */
export const useProjectName = useWorkspaceName;

/**
 * The owning account id, read off the SAME bare project row
 * (`qk.project.summary(id)`, `GET /projects/:id`) `useProjectName` reads, so
 * it shares one cache entry instead of adding a fetch.
 */
export function useWorkspaceAccountId(projectId: string | undefined): string | undefined {
  const { data } = useProjectRow(projectId);
  return data?.account_id;
}

/** @deprecated Use `useWorkspaceAccountId`. Kept permanently. */
export const useProjectAccountId = useWorkspaceAccountId;

/**
 * A project's icon — the emoji XOR the named glyph — read off the SAME
 * bare project row `useProjectName` and `useProjectAccountId` read. No extra fetch, and structurally no way for the name a surface prints
 * and the icon it draws to come from two caches that have diverged.
 *
 * The two fields are returned under their STORED names (`icon`, `icon_glyph`),
 * not renamed to `emoji`/`glyph`. They are a union on the server — writing one
 * clears the other — and a host that reshapes them is a host that can
 * construct a state the server cannot.
 *
 * `undefined` means "the cache has not answered yet". A project that genuinely
 * has no icon returns `{ icon: null, icon_glyph: null }`, because those two
 * render differently: the first is nothing, the second is the initial tile.
 *
 * The returned object is a VALUE, not a stable reference — a fresh one per
 * render. Read its fields; do not put it in a dependency array.
 */
export function useWorkspaceIcon(
  projectId: string | undefined,
): Pick<KortixProject, 'icon' | 'icon_glyph'> | undefined {
  const { data: project } = useProjectRow(projectId);
  if (!project) return undefined;
  return { icon: project.icon ?? null, icon_glyph: project.icon_glyph ?? null };
}

/** @deprecated Use `useWorkspaceIcon`. Kept permanently. */
export const useProjectIcon = useWorkspaceIcon;
