'use client';

import { useQuery } from '@tanstack/react-query';
import type { KortixProject } from '../core/rest/projects-client';
import { getProjectDetail } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { contract } from './query-contracts';

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
 */
export function useProjectName(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: Boolean(projectId),
    ...contract('config'),
  });
  return data?.project?.name;
}

/**
 * The owning account id, read off the SAME `qk.project.detail(id)` entry
 * `useProjectName` reads — every capability surface already mounts that
 * observer, so this shares the cache instead of adding a fetch. Previously
 * lived in `apps/web`'s `project-detail-query.ts` as a host-local hook; moved
 * here because `qk.project.detail` + `contract('config')` is SDK-owned
 * wiring, not something a host should hand-roll a second time.
 */
export function useProjectAccountId(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: Boolean(projectId),
    ...contract('config'),
  });
  return data?.project?.account_id;
}

/**
 * A project's icon — the emoji XOR the named glyph — read off the SAME
 * `qk.project.detail(id)` entry `useProjectName` and `useProjectAccountId`
 * read. No extra fetch, and structurally no way for the name a surface prints
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
export function useProjectIcon(
  projectId: string | undefined,
): Pick<KortixProject, 'icon' | 'icon_glyph'> | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: Boolean(projectId),
    ...contract('config'),
  });
  const project = data?.project;
  if (!project) return undefined;
  return { icon: project.icon ?? null, icon_glyph: project.icon_glyph ?? null };
}
