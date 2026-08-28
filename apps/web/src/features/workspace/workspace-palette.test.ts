import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KortixProject } from '@kortix/sdk';

import {
  ROOT_SUGGESTION_LIMIT,
  WORKSPACE_SWITCHER_ITEM_ID,
  buildRootSuggestions,
} from '@/features/workspace/command-palette';
import { workspaceAccountLabel } from '@/features/workspace/project-sidebar/workspace-grouping';
import {
  ROOT_WORKSPACE_RESULT_LIMIT,
  buildWorkspacePaletteRows,
  filterWorkspacePaletteRows,
  groupWorkspacePaletteRows,
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
  { account_id: 'acct-personal', name: "Jay's Account" },
  { account_id: 'acct-acme', name: 'Acme' },
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

describe('buildWorkspacePaletteRows', () => {
  test('lists workspaces from EVERY account, not just the active one', () => {
    // Defect 1. The palette fetched `listProjectsForAccount(activeAccountId)`,
    // one account. A workspace in a second account was reachable with the
    // trackpad (the sidebar fans out over all accounts) and unreachable from
    // the keyboard.
    const rows = rowsWithActive(SITE.project_id);

    expect(ids(rows).sort()).toEqual(ALL.map((w) => w.project_id).sort());
    expect(new Set(rows.map((r) => r.accountId))).toEqual(
      new Set(['acct-personal', 'acct-acme']),
    );
  });

  test('sorts the active account first, then by most recently opened', () => {
    // The sidebar's order, because it is literally the sidebar's function.
    // Active workspace is in acct-personal, so that account leads; inside it
    // Notes (Aug 25) beats Site (Aug 20).
    expect(names(rowsWithActive(SITE.project_id))).toEqual([
      'Notes',
      'Site',
      'Site',
      'Billing',
    ]);
  });

  test('falls back to alphabetical account order when no workspace is open', () => {
    // Acme < Jay's Account. Nothing is active, so there is no account to
    // promote and the tie-break is the account name.
    expect(rowsWithActive(null).map((r) => r.accountId)).toEqual([
      'acct-acme',
      'acct-acme',
      'acct-personal',
      'acct-personal',
    ]);
  });

  test('marks exactly one row active, and only when that workspace is open', () => {
    const rows = rowsWithActive(ACME_SITE.project_id);
    expect(rows.filter((r) => r.isActive).map((r) => r.workspace.project_id)).toEqual([
      ACME_SITE.project_id,
    ]);
    expect(rowsWithActive(null).some((r) => r.isActive)).toBe(false);
  });

  test('carries the display account label, not the raw account name', () => {
    // The row shows "Jay", so the row must SEARCH "Jay" too — see the
    // search-text tests below.
    const personal = rowsWithActive(null).filter((r) => r.accountId === 'acct-personal');
    expect(personal.map((r) => r.accountName)).toEqual(['Jay', 'Jay']);
  });

  test('keeps a workspace whose account is missing from the roster', () => {
    // An orphan (a shared workspace in an account the user is not a member of)
    // must still be switchable — `groupWorkspacesByAccount` guarantees this and
    // the palette must not undo it by flattening.
    const orphan = workspace('Shared', 'acct-unknown');
    const rows = buildWorkspacePaletteRows({
      accounts: ACCOUNTS,
      workspaces: [...ALL, orphan],
      activeWorkspaceId: null,
    });
    expect(ids(rows)).toContain(orphan.project_id);
    expect(rows.find((r) => r.workspace === orphan)?.accountName).toBe('Account');
  });
});

describe('workspaceAccountLabel', () => {
  test('drops the personal-account suffix, straight or curly apostrophe', () => {
    expect(workspaceAccountLabel("Jay's Account")).toBe('Jay');
    expect(workspaceAccountLabel('Jay’s Account')).toBe('Jay');
  });

  test('leaves an ordinary account name alone', () => {
    expect(workspaceAccountLabel('Acme')).toBe('Acme');
    expect(workspaceAccountLabel('Account Managers')).toBe('Account Managers');
  });

  test('never returns an empty label', () => {
    expect(workspaceAccountLabel('')).toBe('Account');
    expect(workspaceAccountLabel('   ')).toBe('Account');
    expect(workspaceAccountLabel(null)).toBe('Account');
    expect(workspaceAccountLabel(undefined)).toBe('Account');
    // Would strip to nothing — falls back to the trimmed original.
    expect(workspaceAccountLabel("'s Account")).toBe("'s Account");
  });
});

describe('search text and cmdk value', () => {
  const row = rowsWithActive(null).find((r) => r.workspace === ACME_SITE)!;

  test('search text is exactly what the row displays', () => {
    expect(workspacePaletteSearchText(row)).toBe('Site Acme');
  });

  test('the workspace id is in the cmdk value but NOT in the search text', () => {
    // The id is the only thing that separates two same-named workspaces, so
    // cmdk needs it for identity. Putting it in the haystack would repeat the
    // `nav-*`/`proj-*` defect: matching on a string no user has ever seen.
    expect(workspacePaletteValue(row)).toContain(ACME_SITE.project_id);
    expect(workspacePaletteSearchText(row)).not.toContain(ACME_SITE.project_id);
  });

  test('two same-named workspaces in different accounts get different values', () => {
    // cmdk 0.2.1 marks every row sharing a `value` as aria-selected and fires
    // the first on Enter. "Site" exists in both accounts here.
    const values = rowsWithActive(null).map(workspacePaletteValue);
    expect(new Set(values).size).toBe(values.length);
  });

  test('every row the palette can render at once has a unique value', () => {
    // Same guarantee as above but over the whole rendered set, including the
    // pathological case the account label cannot separate: identical names in
    // the SAME account.
    const twins = [
      workspace('Website', 'acct-acme', { project_id: 'p-twin-a' }),
      workspace('Website', 'acct-acme', { project_id: 'p-twin-b' }),
    ];
    const values = buildWorkspacePaletteRows({
      accounts: ACCOUNTS,
      workspaces: [...ALL, ...twins],
      activeWorkspaceId: null,
    }).map(workspacePaletteValue);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('filterWorkspacePaletteRows', () => {
  const rows = rowsWithActive(null);

  test('an empty query returns everything', () => {
    expect(filterWorkspacePaletteRows(rows, '')).toHaveLength(ALL.length);
    expect(filterWorkspacePaletteRows(rows, '   ')).toHaveLength(ALL.length);
  });

  test('matches the workspace name, case-insensitively', () => {
    expect(names(filterWorkspacePaletteRows(rows, 'not'))).toEqual(['Notes']);
    expect(names(filterWorkspacePaletteRows(rows, 'NOTES'))).toEqual(['Notes']);
  });

  test('matches the account label, so an account name lists its workspaces', () => {
    expect(names(filterWorkspacePaletteRows(rows, 'acme')).sort()).toEqual(['Billing', 'Site']);
  });

  test('matches on the STRIPPED account label, which is what the row shows', () => {
    // "jay", not "jay's account" — searching for what is on screen must work.
    expect(names(filterWorkspacePaletteRows(rows, 'jay')).sort()).toEqual(['Notes', 'Site']);
  });

  test('every word must match, and order does not matter', () => {
    expect(ids(filterWorkspacePaletteRows(rows, 'acme site'))).toEqual([ACME_SITE.project_id]);
    expect(ids(filterWorkspacePaletteRows(rows, 'site acme'))).toEqual([ACME_SITE.project_id]);
    expect(filterWorkspacePaletteRows(rows, 'acme notes')).toHaveLength(0);
  });

  test('a query that matches nothing returns nothing rather than everything', () => {
    expect(filterWorkspacePaletteRows(rows, 'zzzz')).toHaveLength(0);
  });
});

describe('rootWorkspaceResults', () => {
  test('answers a query while the user is INSIDE a workspace', () => {
    // Defect 2, and the whole point of the change. The old code was
    // `if (!hasQuery || projectId) return []` — workspaces were suppressed
    // whenever a workspace was open, which is where the palette always is.
    const rows = rowsWithActive(SITE.project_id);
    expect(names(rootWorkspaceResults(rows, 'notes'))).toEqual(['Notes']);
  });

  test('drops the workspace you are already in', () => {
    // It matches its own name better than anything else, so leaving it in
    // makes the top hit a no-op re-navigation to the current page.
    const rows = rowsWithActive(SITE.project_id);
    const hits = rootWorkspaceResults(rows, 'site');
    expect(ids(hits)).toEqual([ACME_SITE.project_id]);
    expect(ids(hits)).not.toContain(SITE.project_id);
  });

  test('returns nothing for an empty query', () => {
    // No query at root means recents, a different list under a different
    // heading.
    expect(rootWorkspaceResults(rowsWithActive(null), '')).toEqual([]);
    expect(rootWorkspaceResults(rowsWithActive(null), '  ')).toEqual([]);
  });

  test('caps at ROOT_WORKSPACE_RESULT_LIMIT so it cannot crowd out other groups', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      workspace(`Site ${i}`, 'acct-acme', { project_id: `p-many-${i}` }),
    );
    const rows = buildWorkspacePaletteRows({
      accounts: ACCOUNTS,
      workspaces: many,
      activeWorkspaceId: null,
    });
    expect(rootWorkspaceResults(rows, 'site')).toHaveLength(ROOT_WORKSPACE_RESULT_LIMIT);
  });
});

describe('workspacePageResults', () => {
  test('KEEPS the active workspace — the page is a directory, not a jump list', () => {
    const rows = rowsWithActive(SITE.project_id);
    expect(ids(workspacePageResults(rows, ''))).toContain(SITE.project_id);
  });

  test('an empty query lists every workspace, in build order', () => {
    const rows = rowsWithActive(SITE.project_id);
    expect(names(workspacePageResults(rows, ''))).toEqual(names(rows));
  });

  test('caps at its own, larger limit', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      workspace(`W${i}`, 'acct-acme', { project_id: `p-cap-${i}` }),
    );
    const rows = buildWorkspacePaletteRows({
      accounts: ACCOUNTS,
      workspaces: many,
      activeWorkspaceId: null,
    });
    expect(workspacePageResults(rows, '')).toHaveLength(50);
  });
});

describe('groupWorkspacePaletteRows', () => {
  test('regroups by account without reordering', () => {
    const rows = rowsWithActive(SITE.project_id);
    const groups = groupWorkspacePaletteRows(rows);

    expect(groups.map((g) => g.accountId)).toEqual(['acct-personal', 'acct-acme']);
    expect(groups.flatMap((g) => names(g.rows))).toEqual(names(rows));
  });

  test('a group appears once, at the position of its first row', () => {
    // Insertion-ordered Map, not a sort. Interleaved input must not produce
    // the same account twice.
    const groups = groupWorkspacePaletteRows([
      ...rowsWithActive(null).filter((r) => r.accountId === 'acct-acme').slice(0, 1),
      ...rowsWithActive(null).filter((r) => r.accountId === 'acct-personal').slice(0, 1),
      ...rowsWithActive(null).filter((r) => r.accountId === 'acct-acme').slice(1, 2),
    ]);
    expect(groups.map((g) => g.accountId)).toEqual(['acct-acme', 'acct-personal']);
    expect(groups[0].rows).toHaveLength(2);
  });

  test('carries the display label onto the group heading', () => {
    const groups = groupWorkspacePaletteRows(rowsWithActive(SITE.project_id));
    expect(groups.map((g) => g.accountName)).toEqual(['Jay', 'Acme']);
  });

  test('an empty list produces no groups, not one empty group', () => {
    expect(groupWorkspacePaletteRows([])).toEqual([]);
  });
});

describe('recentWorkspaceRows', () => {
  test('takes the head of the build order and caps it', () => {
    const rows = rowsWithActive(null);
    expect(recentWorkspaceRows(rows, 2)).toEqual(rows.slice(0, 2));
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

  test('respects the cap and keeps registry order behind the pin', () => {
    const result = buildRootSuggestions(items);
    const rest = items
      .filter((i) => i.group === 'actions' || i.group === 'navigation')
      .filter((i) => i.id !== WORKSPACE_SWITCHER_ITEM_ID)
      .slice(0, ROOT_SUGGESTION_LIMIT - 1)
      .map((i) => i.id);

    expect(result).toHaveLength(ROOT_SUGGESTION_LIMIT);
    expect(result.slice(1).map((i) => i.id)).toEqual(rest);
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

  test('selecting a workspace narrates the switch and re-points the account store', () => {
    // Without `beginSwitch` the palette vanishes into a blank wait; without
    // `setSelectedAccountId` a cross-account switch leaves account-scoped
    // surfaces answering for the account just left. Both are reachable only
    // now that the palette lists other accounts' workspaces at all.
    expect(source.includes('beginSwitch(')).toBe(true);
    expect(source.includes('setSelectedAccountId(')).toBe(true);
  });
});
