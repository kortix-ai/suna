import type { KortixProject } from '@kortix/sdk';

import {
  type GroupWorkspacesInput,
  groupWorkspacesByAccount,
  workspaceAccountLabel,
} from '@/features/workspace/project-sidebar/workspace-grouping';

/**
 * ============================================================================
 * THE COMMAND PALETTE'S WORKSPACE SWITCHER — what rows exist, in what order,
 * and what each one is searchable by.
 * ============================================================================
 *
 * Pure. No React, no query client, no cmdk. The palette is 2,800 lines of
 * component and every rule that used to live inside it was untestable without
 * a DOM this app does not have a harness for (`apps/web` ships no
 * testing-library). Everything that DECIDES something lives here instead, so
 * `workspace-palette.test.ts` exercises the real functions the component
 * calls rather than a re-implementation of them.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * The palette had a workspace switcher already, and it was worse than the
 * mouse in four ways that all came from the same place — it was written as a
 * "projects list" rather than as the switcher the sidebar had become:
 *
 *   1. it fetched ONE account's workspaces (`listProjectsForAccount(active)`),
 *      while the sidebar fans out over every account. A workspace in a second
 *      account was reachable by trackpad and unreachable by keyboard;
 *   2. root search suppressed workspaces entirely whenever you were inside
 *      one — i.e. always — so the only surface that could answer "take me to
 *      Acme" in one keystroke was switched off exactly where it was needed;
 *   3. it said "Project", the word this product retired
 *      (`workspace-vocabulary.test.ts`);
 *   4. every row was the same grey folder glyph, in the one control whose
 *      whole job is being fast to scan.
 *
 * (1) and (2) are fixed by the component; (3) and (4) by the row shape. What
 * is fixed HERE is the part that has to agree with the sidebar: the order, the
 * grouping and the matching. Both switchers now derive from
 * `groupWorkspacesByAccount`, so the account you are in sorts first, its
 * workspaces sort by how recently you opened them, and the two controls can no
 * longer disagree about what the list is.
 *
 * ---------------------------------------------------------------------------
 * Search text vs. cmdk value — they are NOT the same string
 * ---------------------------------------------------------------------------
 *
 * cmdk 0.2.1 (the installed version) has no `keywords` prop, so a row's
 * `value` is simultaneously its search text AND its selection identity, and
 * cmdk requires the identity to be unique — two rows sharing a `value` are
 * both marked `aria-selected` and Enter always fires the first one. Two
 * workspaces called "Website" in two different accounts is an ordinary thing
 * to own, so name-plus-account is NOT a safe identity.
 *
 * Hence two functions:
 *
 * - {@link workspacePaletteSearchText} is what a query is matched against, and
 *   it is exactly what the row puts on screen — name and account label,
 *   nothing else. Every group in the palette renders with `forceMount`, which
 *   cmdk propagates to its items, so cmdk never REMOVES a row; it only ranks
 *   them. {@link filterWorkspacePaletteRows} is therefore the sole authority
 *   on which workspace rows exist.
 * - {@link workspacePaletteValue} appends the workspace id, which makes the
 *   identity unique without making the id searchable — the id is not in the
 *   haystack the filter reads. This is the same split
 *   `buildPaletteSearchText`'s doc comment describes for registry rows, where
 *   the lesson was learned the other way round: `nav-*`/`proj-*` slugs WERE in
 *   the match text, so "nav" returned eleven rows by a string no user has
 *   ever seen.
 */

export interface WorkspacePaletteRow {
  workspace: KortixProject;
  accountId: string;
  /** Already display-ready — see {@link workspaceAccountLabel}. */
  accountName: string;
  /** The workspace the user is looking at right now. */
  isActive: boolean;
}

export interface WorkspacePaletteGroup {
  accountId: string;
  accountName: string;
  rows: WorkspacePaletteRow[];
}

/**
 * How many workspaces a ROOT search offers before it stops.
 *
 * Root is a mixed result page — navigation, settings, sessions, workspaces,
 * URL detection — and workspaces are one voice in it, so they take a slice
 * rather than the page. Five, not the eight the old project rows used: the
 * rows above them are the ones the user asked for by name most of the time,
 * and a workspace list long enough to push Settings off screen turns a search
 * into a scroll. The full list is one Enter away on the dedicated page, which
 * caps at {@link WORKSPACE_PAGE_RESULT_LIMIT}.
 */
export const ROOT_WORKSPACE_RESULT_LIMIT = 5;

/**
 * How many rows the dedicated Switch Workspace page renders.
 *
 * A cap, not a page size — there is no "show more". 50 is the same number the
 * page it replaces used, and it is a render-cost guard rather than a product
 * decision: the sidebar's directory is deliberately uncapped
 * (`filterWorkspaceGroups`), so a user past 50 workspaces still has one
 * complete list, and the palette's search reaches any of them by name.
 */
export const WORKSPACE_PAGE_RESULT_LIMIT = 50;

/**
 * Every workspace the user can reach, flattened out of
 * {@link groupWorkspacesByAccount} in that function's order: the account you
 * are in first, then the rest alphabetically, and inside each, most recently
 * opened first.
 *
 * Flat rather than grouped because the ROOT search shows a plain top-5 with no
 * account headings at all — grouping there would put a one-row heading above
 * each result. {@link groupWorkspacePaletteRows} puts the headings back for
 * the dedicated page, and because it preserves order it cannot reorder what
 * the sidebar shows.
 */
export function buildWorkspacePaletteRows({
  accounts,
  workspaces,
  activeWorkspaceId,
}: GroupWorkspacesInput): WorkspacePaletteRow[] {
  return groupWorkspacesByAccount({ accounts, workspaces, activeWorkspaceId }).flatMap((group) =>
    group.workspaces.map((workspace) => ({
      workspace,
      accountId: group.accountId,
      accountName: workspaceAccountLabel(group.accountName),
      isActive: workspace.project_id === activeWorkspaceId,
    })),
  );
}

/**
 * What a query is matched against — and, deliberately, exactly what the row
 * puts on screen.
 *
 * The account label is in here because the palette shows it (as trailing muted
 * text, whenever the user belongs to more than one account), so "acme" is a
 * legitimate way to ask for Acme's workspaces. It would be wrong to match on
 * an account name the row does not display.
 */
export function workspacePaletteSearchText(row: WorkspacePaletteRow): string {
  return `${row.workspace.name} ${row.accountName}`;
}

/**
 * The row's cmdk `value` — its selection identity. Search text plus the
 * workspace id, which is the only field guaranteed to differ between two
 * same-named workspaces in the same account.
 *
 * Callers must still run this through the palette's `sanitizeCmdkValue`,
 * which strips the quote/bracket characters cmdk cannot carry in a value. That
 * lives in the component with every other cmdk detail; this module stays
 * unaware of cmdk.
 */
export function workspacePaletteValue(row: WorkspacePaletteRow): string {
  return `workspace ${workspacePaletteSearchText(row)} ${row.workspace.project_id}`;
}

/**
 * Per-word substring match, every word required, order irrelevant.
 *
 * The same rule `filteredNavItems` and `filterSettingsPaletteGroups` apply, on
 * purpose: one query typed into one input must not mean two different things
 * depending on which group is answering it. It is looser than cmdk's ordered
 * subsequence score, which is what lets "acme site" find "Site" in "Acme"
 * while cmdk merely ranks it.
 */
export function filterWorkspacePaletteRows(
  rows: WorkspacePaletteRow[],
  query: string,
): WorkspacePaletteRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = workspacePaletteSearchText(row).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The workspace rows a ROOT query offers.
 *
 * Two rules the old implementation got wrong, both of them about the case that
 * matters most — the user is already inside a workspace, which is where the
 * palette spends its entire life:
 *
 * - it is NOT gated on being outside a workspace. The old code returned `[]`
 *   the moment `projectId` was set, so typing a workspace name at the root
 *   found nothing and the switcher was only reachable by first selecting a row
 *   called "Projects". That two-step is the whole complaint this change
 *   answers;
 * - the ACTIVE workspace is dropped. It is the one row that cannot do
 *   anything: selecting it re-navigates to the page you are on. It also
 *   matches its own name better than anything else does, so leaving it in
 *   means the top hit for the workspace you are in is a no-op.
 *
 * Empty for an empty query — root with no query shows recents, which is a
 * different list with a different heading.
 */
export function rootWorkspaceResults(
  rows: WorkspacePaletteRow[],
  query: string,
  limit: number = ROOT_WORKSPACE_RESULT_LIMIT,
): WorkspacePaletteRow[] {
  if (!query.trim()) return [];
  return filterWorkspacePaletteRows(rows, query)
    .filter((row) => !row.isActive)
    .slice(0, limit);
}

/**
 * The rows the dedicated Switch Workspace page renders, capped.
 *
 * Keeps the active workspace, unlike {@link rootWorkspaceResults} — this page
 * is the directory, and a directory that omits where you are makes you doubt
 * it. The component marks that row with a check instead.
 */
export function workspacePageResults(
  rows: WorkspacePaletteRow[],
  query: string,
  limit: number = WORKSPACE_PAGE_RESULT_LIMIT,
): WorkspacePaletteRow[] {
  return filterWorkspacePaletteRows(rows, query).slice(0, limit);
}

/**
 * Re-group flat rows by account for the dedicated page, preserving the order
 * {@link buildWorkspacePaletteRows} established.
 *
 * Insertion-ordered `Map`, not a sort: the rows arrive in the sidebar's order
 * and re-sorting here is how the two controls would start disagreeing. A group
 * appears at the position of its first row and nowhere else.
 */
export function groupWorkspacePaletteRows(rows: WorkspacePaletteRow[]): WorkspacePaletteGroup[] {
  const groups = new Map<string, WorkspacePaletteGroup>();
  for (const row of rows) {
    const existing = groups.get(row.accountId);
    if (existing) existing.rows.push(row);
    else
      groups.set(row.accountId, {
        accountId: row.accountId,
        accountName: row.accountName,
        rows: [row],
      });
  }
  return [...groups.values()];
}

/**
 * The recent workspaces the root page shows with NO query, when the user is
 * not inside a workspace.
 *
 * Inside a workspace this list is not offered at all — recent SESSIONS take
 * that space, because a user who is already somewhere is far likelier to want
 * a thread in it than a different workspace. Search covers the other case, and
 * now does so from inside a workspace too.
 */
export function recentWorkspaceRows(
  rows: WorkspacePaletteRow[],
  limit = 5,
): WorkspacePaletteRow[] {
  return rows.slice(0, limit);
}
