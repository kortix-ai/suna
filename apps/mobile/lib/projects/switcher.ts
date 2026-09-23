/**
 * switcher — pure decision logic for `ProjectSwitcherSheet`
 * (components/projects/ProjectSwitcherSheet.tsx): the account chip row's
 * order, whether the project search field shows, and the search filter
 * itself.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

/** The project list gets a search field once an account has more than this many. */
export const SWITCHER_SEARCH_THRESHOLD = 6;

/** Show the "Search projects" field only once the list is long enough to need it. */
export function shouldShowProjectSearch(projectCount: number): boolean {
  return projectCount > SWITCHER_SEARCH_THRESHOLD;
}

/** One account chip, or the "New account" chip that always sits last. */
export type SwitcherChip = { kind: 'account'; account: KortixAccount } | { kind: 'new-account' };

/**
 * The account chips row: every account in the order the server returned them
 * (unreordered — the same order the rest of the app lists accounts in), with
 * the "New account" chip appended last. The row always renders, even with
 * one account, so a one-account user can still start a second one.
 */
export function switcherChips(accounts: KortixAccount[]): SwitcherChip[] {
  return [
    ...accounts.map((account): SwitcherChip => ({ kind: 'account', account })),
    { kind: 'new-account' },
  ];
}

/** Case-insensitive, trimmed substring match on the project name. */
export function filterProjectsByQuery(projects: KortixProject[], query: string): KortixProject[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((project) => project.name.toLowerCase().includes(q));
}

/**
 * The route a project opens at — shared by the switcher sheet and the
 * Projects tab (`router.replace`). expo-router's typed routes need the
 * dynamic segment as `params`, not interpolated into `pathname`, so this
 * returns the `Href` shape directly rather than a path string.
 */
export interface ProjectHref {
  pathname: '/projects/[id]';
  params: { id: string };
}

export function projectHref(projectId: string): ProjectHref {
  return { pathname: '/projects/[id]', params: { id: projectId } };
}
