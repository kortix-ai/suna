/**
 * Where `/` sends a signed-in user.
 *
 * Pure: the caller does the I/O and hands in what it fetched. That keeps the
 * fallback chain — which decides whether someone lands in their work or on a
 * grid of cards — testable without a backend.
 */

import { isValidProjectId } from '@/lib/home/last-project-cookie';

export interface LandingProjectCandidate {
  project_id?: string | null;
  last_opened_at?: string | null;
}

/** Cap the account sweep. Someone in twenty orgs must not wait for twenty round trips. */
export const MAX_ACCOUNTS_TO_SEARCH = 3;

/** Most recently opened first, matching the project switcher's own ordering. */
export function sortByLastOpened<T extends LandingProjectCandidate>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    const at = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
    const bt = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
    return bt - at;
  });
}

/**
 * Pick the project to open.
 *
 * 1. The cookie, if it names a project the user can still see.
 * 2. Otherwise the most recently opened project, account by account.
 *
 * Returns null when there is nothing to open — the caller sends those users to
 * /projects, which already has the right empty state. Deliberately does NOT
 * provision: `ensure-first-project.ts` documents that an empty account returns
 * null on purpose, because owning a repo is the user's choice. Signup
 * provisioning happens server-side in the auth callback.
 */
export function resolveLandingProjectId(input: {
  cookieProjectId?: string | null;
  /** Visible projects per account, in the order accounts should be searched. */
  projectsByAccount: readonly (readonly LandingProjectCandidate[])[];
}): string | null {
  const visible = new Set<string>();
  for (const projects of input.projectsByAccount) {
    for (const project of projects) {
      if (project.project_id) visible.add(project.project_id);
    }
  }

  // Only honour the cookie if the project is still visible — otherwise a
  // deleted or revoked project would send the user to a 404 on every visit.
  const cookieId = input.cookieProjectId;
  if (cookieId && isValidProjectId(cookieId) && visible.has(cookieId)) {
    return cookieId;
  }

  for (const projects of input.projectsByAccount) {
    // Drop unopenable entries BEFORE sorting: an id-less row would otherwise
    // sort to the front and short-circuit the whole fallback.
    const openable = projects.filter((project) => !!project.project_id);
    const [newest] = sortByLastOpened(openable);
    if (newest?.project_id) return newest.project_id;
  }

  return null;
}

/** The path `/` redirects to. Never throws, never returns an off-site target. */
export function resolveLandingPath(input: {
  cookieProjectId?: string | null;
  projectsByAccount: readonly (readonly LandingProjectCandidate[])[];
}): string {
  try {
    const projectId = resolveLandingProjectId(input);
    return projectId ? `/projects/${projectId}` : '/projects';
  } catch {
    // A backend blip must never turn the homepage into a dead end.
    return '/projects';
  }
}
