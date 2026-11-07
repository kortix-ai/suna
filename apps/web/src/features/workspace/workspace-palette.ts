import type { KortixAccount, KortixProject } from '@kortix/sdk';

import { buildWorkspaceRows } from '@kortix/ui/workspace/project-selector/project-selector-model';

/**
 * ============================================================================
 * THE COMMAND PALETTE'S WORKSPACE SWITCHER — what rows exist, in what order,
 * and what each one is searchable by.
 * ============================================================================
 *
 * Pure. No React, no query client, no cmdk: everything that DECIDES something
 * lives here, so `workspace-palette.test.ts` exercises the real functions the
 * component calls.
 *
 * The palette and the sidebar switcher list the same thing the same way: one
 * flat row per workspace (a workspace is one account and its project), most
 * recently opened first, no account headings. Both derive from
 * `buildWorkspaceRows` in `@kortix/ui`, so the two controls cannot disagree
 * about what the list is.
 *
 * ---------------------------------------------------------------------------
 * Search text vs. cmdk value — they are NOT the same string
 * ---------------------------------------------------------------------------
 *
 * cmdk 0.2.1 (the installed version) has no `keywords` prop, so a row's
 * `value` is simultaneously its search text AND its selection identity, and
 * cmdk requires the identity to be unique — two rows sharing a `value` are
 * both marked `aria-selected` and Enter always fires the first one. A legacy
 * account can hold two workspaces with one name, so the name alone is NOT a
 * safe identity.
 *
 * - {@link workspacePaletteSearchText} is what a query is matched against, and
 *   it is exactly what the row puts on screen: the workspace name.
 *   {@link filterWorkspacePaletteRows} is the sole authority on which rows
 *   exist (every palette group renders with `forceMount`).
 * - {@link workspacePaletteValue} appends the workspace id, which makes the
 *   identity unique without making the id searchable.
 */

export interface WorkspacePaletteRow {
  workspace: KortixProject;
  accountId: string;
  /** The workspace the user is looking at right now. */
  isActive: boolean;
}

/**
 * How many workspaces a ROOT search offers before it stops. Root is a mixed
 * result page, so workspaces take a slice rather than the page. The full list
 * is one Enter away on the dedicated page.
 */
export const ROOT_WORKSPACE_RESULT_LIMIT = 5;

/**
 * How many rows the dedicated Switch workspace page renders. A render-cost
 * guard, not a page size: search reaches any workspace by name.
 */
export const WORKSPACE_PAGE_RESULT_LIMIT = 50;

/** Every workspace the user can reach, in the sidebar's order. */
export function buildWorkspacePaletteRows({
  accounts,
  workspaces,
  activeWorkspaceId,
}: {
  accounts: Pick<KortixAccount, 'account_id' | 'name' | 'account_role'>[];
  workspaces: KortixProject[];
  activeWorkspaceId: string | null | undefined;
}): WorkspacePaletteRow[] {
  return buildWorkspaceRows({
    accounts: accounts as KortixAccount[],
    lists: [{ accountId: '*', data: workspaces, isError: false }],
  }).map((row) => ({
    workspace: row.project,
    accountId: row.accountId,
    isActive: row.workspaceId === activeWorkspaceId,
  }));
}

/** What a query is matched against — exactly what the row shows. */
export function workspacePaletteSearchText(row: WorkspacePaletteRow): string {
  return row.workspace.name;
}

/**
 * The row's cmdk `value` — its selection identity. Search text plus the
 * workspace id. Callers still run it through the palette's `sanitizeCmdkValue`.
 */
export function workspacePaletteValue(row: WorkspacePaletteRow): string {
  return `workspace ${workspacePaletteSearchText(row)} ${row.workspace.project_id}`;
}

/**
 * Per-word substring match, every word required, order irrelevant — the same
 * rule every other palette group applies to one query.
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
 * The workspace rows a ROOT query offers. Not gated on being outside a
 * workspace, and the ACTIVE workspace stays searchable. Empty for an empty
 * query — root with no query shows recents.
 */
export function rootWorkspaceResults(
  rows: WorkspacePaletteRow[],
  query: string,
  limit: number = ROOT_WORKSPACE_RESULT_LIMIT,
): WorkspacePaletteRow[] {
  if (!query.trim()) return [];
  return filterWorkspacePaletteRows(rows, query).slice(0, limit);
}

/** The rows the dedicated Switch workspace page renders, capped. Keeps the active one. */
export function workspacePageResults(
  rows: WorkspacePaletteRow[],
  query: string,
  limit: number = WORKSPACE_PAGE_RESULT_LIMIT,
): WorkspacePaletteRow[] {
  return filterWorkspacePaletteRows(rows, query).slice(0, limit);
}

/**
 * The recent workspaces the root page shows with NO query, when the user is
 * not inside a workspace. Inside one, recent SESSIONS take that space.
 */
export function recentWorkspaceRows(rows: WorkspacePaletteRow[], limit = 5): WorkspacePaletteRow[] {
  return rows.slice(0, limit);
}
