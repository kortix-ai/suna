import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KortixProject } from '@kortix/sdk';

import {
  ROOT_SUGGESTION_LIMIT,
  SEARCH_ONLY_ITEM_IDS,
  SUGGESTION_PRIORITY,
  WORKSPACE_SWITCHER_ITEM_ID,
  buildRootSuggestions,
} from '@/features/workspace/command-palette';
import {
  ROOT_WORKSPACE_RESULT_LIMIT,
  buildWorkspacePaletteRows,
  filterWorkspacePaletteRows,
  recentWorkspaceRows,
  rootWorkspaceResults,
  workspacePageResults,
  workspacePaletteSearchText,
  workspacePaletteValue,
} from '@/features/workspace/workspace-palette';
import { getItemsForSurface } from '@/lib/menu-registry';

/**
 * ============================================================================
 * THE PALETTE'S WORKSPACE SWITCHER
 * ============================================================================
 *
 * Every test here names a defect the old implementation had. The palette's
 * switcher was a "projects list" bolted on beside a sidebar switcher that had
 * since become the product's whole workspace directory, and the four ways it
 * had fallen behind are pinned individually below so none of them can come
 * back quietly.
 *
 * No DOM. These are the same pure functions the component calls — `apps/web`
 * has no React test harness, and a source-text assertion about a component
 * cannot tell "renders the right rows" from "renders nothing"
 * (`workspace-vocabulary.test.ts` says the same thing about its absence
 * checks). The one source-text test in this file is deliberately paired with
 * a behavioural one, and it asserts a string's PRESENCE for that reason.
 */

function workspace(
  name: string,
  accountId: string,
  overrides: Partial<KortixProject> = {},
): KortixProject {
  return {
    project_id: `p-${name.toLowerCase().replaceAll(' ', '-')}-${accountId}`,
    account_id: accountId,
    name,
    icon: null,
    last_opened_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as KortixProject;
}

const ACCOUNTS = [
  { account_id: 'acct-personal', name: "Jay's Account", account_role: 'owner' },
  { account_id: 'acct-acme', name: 'Acme', account_role: 'member' },
];

const SITE = workspace('Site', 'acct-personal', { last_opened_at: '2026-08-20T00:00:00.000Z' });
const NOTES = workspace('Notes', 'acct-personal', { last_opened_at: '2026-08-25T00:00:00.000Z' });
const ACME_SITE = workspace('Site', 'acct-acme', { last_opened_at: '2026-08-10T00:00:00.000Z' });
const BILLING = workspace('Billing', 'acct-acme');

const ALL = [SITE, NOTES, ACME_SITE, BILLING];

function rowsWithActive(activeWorkspaceId: string | null) {
  return buildWorkspacePaletteRows({
    accounts: ACCOUNTS,
    workspaces: ALL,
    activeWorkspaceId,
  });
}

const names = (rows: { workspace: KortixProject }[]) => rows.map((r) => r.workspace.name);
const ids = (rows: { workspace: KortixProject }[]) => rows.map((r) => r.workspace.project_id);

describe('buildWorkspacePaletteRows — one flat list, the sidebar order', () => {
  test('lists workspaces from EVERY account, not just the active one', () => {
    expect(ids(rowsWithActive(null)).sort()).toEqual(ALL.map((p) => p.project_id).sort());
  });

  test('sorts by most recently opened across accounts, with no account grouping', () => {
    expect(names(rowsWithActive(SITE.project_id))).toEqual(['Notes', 'Site', 'Site', 'Billing']);
    expect(rowsWithActive(null).map((r) => r.accountId)).toEqual([
      'acct-personal',
      'acct-personal',
      'acct-acme',
      'acct-acme',
    ]);
  });

  test('marks exactly one row active, and only when that workspace is open', () => {
    expect(rowsWithActive(ACME_SITE.project_id).filter((r) => r.isActive).map((r) => r.workspace.project_id)).toEqual([
      ACME_SITE.project_id,
    ]);
    expect(rowsWithActive(null).some((r) => r.isActive)).toBe(false);
  });

  test('keeps a workspace whose account is missing from the roster', () => {
    const orphan = workspace('Shared', 'acct-elsewhere');
    const rows = buildWorkspacePaletteRows({ accounts: ACCOUNTS, workspaces: [orphan], activeWorkspaceId: null });
    expect(names(rows)).toEqual(['Shared']);
  });
});

describe('search text and cmdk value', () => {
  const rows = rowsWithActive(null);

  test('search text is exactly what the row displays: the workspace name', () => {
    expect(rows.map(workspacePaletteSearchText)).toEqual(names(rows));
  });

  test('the workspace id is in the cmdk value but NOT in the search text', () => {
    const row = rows[0]!;
    expect(workspacePaletteValue(row)).toContain(row.workspace.project_id);
    expect(workspacePaletteSearchText(row)).not.toContain(row.workspace.project_id);
  });

  test('two same-named workspaces get different values', () => {
    const sites = rows.filter((r) => r.workspace.name === 'Site');
    expect(sites).toHaveLength(2);
    expect(workspacePaletteValue(sites[0]!)).not.toBe(workspacePaletteValue(sites[1]!));
  });
});

describe('filterWorkspacePaletteRows', () => {
  const rows = rowsWithActive(null);

  test('an empty query returns everything', () => {
    expect(filterWorkspacePaletteRows(rows, '   ')).toEqual(rows);
  });

  test('matches the workspace name, case-insensitively, every word required', () => {
    expect(names(filterWorkspacePaletteRows(rows, 'SITE'))).toEqual(['Site', 'Site']);
    expect(filterWorkspacePaletteRows(rows, 'site notes')).toEqual([]);
  });

  test('does not match an account name: the account is not a separate thing', () => {
    expect(filterWorkspacePaletteRows(rows, 'acme')).toEqual([]);
  });
});

describe('rootWorkspaceResults', () => {
  test('answers a query while the user is INSIDE a workspace, the open one included', () => {
    const rows = rowsWithActive(SITE.project_id);
    expect(ids(rootWorkspaceResults(rows, 'site'))).toContain(SITE.project_id);
  });

  test('returns nothing for an empty query', () => {
    expect(rootWorkspaceResults(rowsWithActive(null), '')).toEqual([]);
  });

  test('caps at ROOT_WORKSPACE_RESULT_LIMIT so it cannot crowd out other groups', () => {
    const many = Array.from({ length: 12 }, (_, i) => workspace(`Proj ${i}`, 'acct-acme'));
    const rows = buildWorkspacePaletteRows({ accounts: ACCOUNTS, workspaces: many, activeWorkspaceId: null });
    expect(rootWorkspaceResults(rows, 'proj')).toHaveLength(ROOT_WORKSPACE_RESULT_LIMIT);
  });
});

describe('workspacePageResults and recentWorkspaceRows', () => {
  test('the page KEEPS the active workspace and lists everything for an empty query', () => {
    const rows = rowsWithActive(NOTES.project_id);
    expect(workspacePageResults(rows, '')).toEqual(rows);
    expect(workspacePageResults(rows, 'notes')[0]?.isActive).toBe(true);
  });

  test('recents take the head of the build order and cap it', () => {
    expect(recentWorkspaceRows(rowsWithActive(null), 2)).toHaveLength(2);
  });
});

describe('buildRootSuggestions — the no-query root page', () => {
  const items = getItemsForSurface('commandPalette');

  test('offers the workspace switcher FIRST', () => {
    // The defect this pin fixes: opening ⌘K and typing nothing showed eight
    // session/terminal actions and no way to change workspace at all.
    expect(buildRootSuggestions(items)[0]?.id).toBe(WORKSPACE_SWITCHER_ITEM_ID);
  });

  test('the switcher would NOT survive the cap unpinned — the pin is load-bearing', () => {
    // Pins the reason. If the registry is ever reordered so the switcher lands
    // inside the first `ROOT_SUGGESTION_LIMIT` on its own, this fails and the
    // pin can be reconsidered rather than cargo-culted forever.
    const unpinned = items.filter((i) => i.group === 'actions' || i.group === 'navigation');
    const naturalIndex = unpinned.findIndex((i) => i.id === WORKSPACE_SWITCHER_ITEM_ID);

    expect(naturalIndex).toBeGreaterThanOrEqual(0);
    expect(naturalIndex).toBeGreaterThanOrEqual(ROOT_SUGGESTION_LIMIT);
  });

  test('lists the switcher exactly once', () => {
    // A pin that also duplicated would collide on `key={item.id}` and be a
    // worse bug than the one it fixes.
    const ids = buildRootSuggestions(items).map((i) => i.id);
    expect(ids.filter((id) => id === WORKSPACE_SWITCHER_ITEM_ID)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('leads with the everyday moves in SUGGESTION_PRIORITY order, then registry order, capped', () => {
    const result = buildRootSuggestions(items).map((i) => i.id);
    const available = new Set(items.map((i) => i.id));
    const leading = SUGGESTION_PRIORITY.filter((id) => available.has(id)).slice(
      0,
      ROOT_SUGGESTION_LIMIT,
    );

    expect(result).toHaveLength(ROOT_SUGGESTION_LIMIT);
    expect(result.slice(0, leading.length)).toEqual(leading);
    expect(result[0]).toBe(WORKSPACE_SWITCHER_ITEM_ID);
    // Registry order put Compact Session second; the everyday moves above now
    // lead it, and rarer actions such as Restart Config fall past the cap.
    expect(result).not.toContain('restart-config');
  });

  test('search-only rows (New session, Open Audit, Home, Open session) are absent from Suggestions, still in the registry', () => {
    const suggested = buildRootSuggestions(items).map((i) => i.id);
    for (const id of SEARCH_ONLY_ITEM_IDS) {
      expect(suggested).not.toContain(id);
      expect(items.map((i) => i.id)).toContain(id);
    }
  });

  test('offers only actions and navigation rows', () => {
    for (const item of buildRootSuggestions(items)) {
      expect(['actions', 'navigation']).toContain(item.group);
    }
  });

  test('degrades to plain registry order if the switcher row disappears', () => {
    const without = items.filter((i) => i.id !== WORKSPACE_SWITCHER_ITEM_ID);
    const result = buildRootSuggestions(without);
    expect(result.map((i) => i.id)).not.toContain(WORKSPACE_SWITCHER_ITEM_ID);
    expect(result).toHaveLength(ROOT_SUGGESTION_LIMIT);
  });
});

/**
 * Paired presence check. Everything above is behavioural, but the component is
 * where the behaviour is WIRED, and the two defects that cost the most were
 * both wiring: a `return []` guard and a single-account fetch. A behavioural
 * suite cannot see either.
 *
 * These assert the presence of the specific call sites, and each one is stated
 * as the thing that must be true rather than as a string that happens to be
 * there — so a rename fails loudly instead of passing vacuously.
 *
 * `expect(source.includes(x)).toBe(true)` rather than
 * `expect(source).toContain(x)`: the latter prints the ENTIRE 2,800-line file
 * as `Received` on failure, which buries the one line that matters under
 * 350KB of noise. The boolean form fails just as loudly and reads
 * `Expected: true / Received: false`.
 */
describe('command-palette.tsx wires the switcher to these functions', () => {
  const source = readFileSync(join(import.meta.dir, 'command-palette.tsx'), 'utf8');

  test('root results come from rootWorkspaceResults, and nothing gates them on projectId', () => {
    expect(source.includes('rootWorkspaceResults(')).toBe(true);
    // The exact guard that caused the bug. Any form of it coming back fails.
    expect(source.includes('if (!hasQuery || projectId) return [];')).toBe(false);
  });

  test('the workspace list is fanned out over every account with useQueries', () => {
    expect(source.includes('useQueries')).toBe(true);
    expect(source.includes('buildWorkspacePaletteRows')).toBe(true);
  });

  test('the Switch workspace page has no account headings and no account switcher page', () => {
    expect(source.includes('groupWorkspacePaletteRows')).toBe(false);
    expect(source.includes("page === 'accounts'")).toBe(false);
  });

  test('selecting a workspace narrates the switch and re-points the account store', () => {
    // Without `beginSwitch` the palette vanishes into a blank wait; without
    // `setSelectedAccountId` a cross-account switch leaves account-scoped
    // surfaces answering for the account just left. Both are reachable only
    // now that the palette lists other accounts' workspaces at all.
    expect(source.includes('beginSwitch(')).toBe(true);
    expect(source.includes('setSelectedAccountId(')).toBe(true);
  });
});
