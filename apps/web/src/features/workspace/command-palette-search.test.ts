import { describe, expect, test } from 'bun:test';

import { buildPaletteSearchText } from '@/features/workspace/command-palette';
import { LEGACY_PALETTE_HIDDEN } from '@/features/workspace/command-palette-visibility';
import {
  settingsPaletteGroups,
  settingsPaletteSearchText,
  type SettingsPaletteParams,
} from '@/features/workspace/settings-palette-items';
import { getItemsForSurface, menuRegistry } from '@/lib/menu-registry';

/**
 * ============================================================================
 * WHAT THE PALETTE IS SEARCHABLE BY — and what it must never be searchable by.
 * ============================================================================
 *
 * Three defects shared one root cause: the palette matched on strings the user
 * has never seen.
 *
 *   A. `item.id` was in the match text. "proj" returned all ten `proj-*` rows,
 *      "nav" all eleven `nav-*`/`proj-*` rows, "pref" the preferences rows,
 *      "account" the `account-*` rows.
 *   B. `item.group` was in the match text. "view" returned Toggle Sidebar and
 *      Log Out because both sit in the `view` group.
 *   C. Keyword bags carried words that name a DIFFERENT row's subject. Typing
 *      "member" returned the ACCOUNT SWITCHER, because `nav-accounts` carried
 *      `members`. Twelve settings tabs plus five navigation rows carried the
 *      legacy `project customize` tail, so "customize" returned seventeen rows.
 *
 * A and B are structural and are pinned structurally below: the match text is
 * label + curated keywords (+ the rail group heading, which is on screen), and
 * nothing else. C is a judgement call per word, so the queries people actually
 * type are pinned as a table.
 *
 * These tests need no DOM. `buildPaletteSearchText` and
 * `settingsPaletteSearchText` are the same pure functions the component feeds
 * to cmdk, and the matcher below is the same per-word substring rule
 * `filteredNavItems` and `filterSettingsPaletteGroups` apply. Since both groups
 * now render their rows with `forceMount`, that rule is the ONLY thing deciding
 * what a query shows — so this file tests the real contract, not a model of it.
 */

const IN_A_PROJECT: SettingsPaletteParams = { hasProject: true };

/** Mirrors `sanitizeCmdkValue` in command-palette.tsx. */
function sanitize(value: string): string {
  return value
    .replace(/["'\\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Row {
  /** `nav:<registry id>` or `settings:<tab>` — for readable failures only. */
  key: string;
  label: string;
  /** Everything the row is searchable by. */
  text: string;
  /** The cmdk `value`, i.e. the row's selection identity. */
  value: string;
  /** Every string the user has actually read on screen for this row. */
  visible: string[];
}

const navRows: Row[] = getItemsForSurface('commandPalette')
  .filter((item) => !LEGACY_PALETTE_HIDDEN.has(item.id))
  .map((item) => ({
    key: `nav:${item.id}`,
    label: item.label,
    text: buildPaletteSearchText(item),
    value: buildPaletteSearchText(item),
    visible: [item.label, item.keywords ?? ''],
  }));

const settingsRows: Row[] = settingsPaletteGroups(IN_A_PROJECT).flatMap((group) =>
  group.items.map((item) => ({
    key: `settings:${item.tab}`,
    label: item.label,
    text: settingsPaletteSearchText(item),
    value: sanitize(`settings ${settingsPaletteSearchText(item)}`),
    visible: [item.label, item.groupLabel, item.keywords, 'settings'],
  })),
);

/** Every row the palette can render at the same time for one query. */
const allRows = [...navRows, ...settingsRows];

/** The palette's own rule: every word of the query is a substring of the text. */
function matches(row: Row, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = row.text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const hits = (query: string) => allRows.filter((row) => matches(row, query)).map((row) => row.key);

// ============================================================================
// 1. Selection identity — cmdk uses `value` as the row's identity and requires
//    it to be unique. Two rows sharing one are BOTH marked `aria-selected` and
//    Enter always fires the first, so a duplicate is worse than the bug this
//    file exists to fix. `item.id` used to guarantee uniqueness; removing it
//    moves the guarantee onto the curated text, which is safe only while this
//    passes. cmdk 0.2.1 has no `keywords` prop to separate the two concerns.
// ============================================================================

describe('cmdk value uniqueness', () => {
  test('every value the palette can render at once is unique', () => {
    const byValue = new Map<string, string[]>();
    for (const row of allRows) {
      const value = row.value.toLowerCase();
      byValue.set(value, [...(byValue.get(value) ?? []), row.key]);
    }
    const collisions = [...byValue].filter(([, keys]) => keys.length > 1);
    expect(collisions).toEqual([]);
    expect(byValue.size).toBe(allRows.length);
  });

  test('uniqueness survives the project-less palette, which offers a different set', () => {
    const rows = [
      ...navRows,
      ...settingsPaletteGroups({ ...IN_A_PROJECT, hasProject: false }).flatMap((group) =>
        group.items.map((item) => sanitize(`settings ${settingsPaletteSearchText(item)}`)),
      ),
    ].map((row) => (typeof row === 'string' ? row : row.value).toLowerCase());
    expect(new Set(rows).size).toBe(rows.length);
  });

  test('no row is searchable by an empty string', () => {
    for (const row of allRows) expect(row.value.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 2. Structural — the match text is user-visible text and nothing else.
// ============================================================================

describe('only user-visible text is searchable', () => {
  test('the navigation match text is exactly label + keywords', () => {
    for (const item of menuRegistry) {
      expect(buildPaletteSearchText(item)).toBe(sanitize(`${item.label} ${item.keywords ?? ''}`));
    }
  });

  test('no internal id is smuggled into the text of the row it identifies', () => {
    for (const item of menuRegistry) {
      const text = buildPaletteSearchText(item).toLowerCase();
      // Some ids are just the label lowercased (`files`, `workspace`,
      // `logout`). Those are fine — the word is on screen. The test is that no
      // id is present as an id, i.e. as a string the visible text does not
      // already contain in its own right.
      const words = new Set(text.split(' '));
      if (words.has(item.id.toLowerCase())) continue;
      expect({
        id: item.id,
        smuggledInto: text.includes(item.id.toLowerCase()) ? text : null,
      }).toEqual({ id: item.id, smuggledInto: null });
    }
  });

  test('every word of a value comes from something the user has read', () => {
    for (const row of allRows) {
      const allowed = new Set(sanitize(row.visible.join(' ')).toLowerCase().split(' '));
      const strays = row.value
        .toLowerCase()
        .split(' ')
        .filter((word) => !allowed.has(word));
      expect({ row: row.key, strays }).toEqual({ row: row.key, strays: [] });
    }
  });

  /**
   * The general invariant the three defects all violated: a query that appears
   * nowhere in a row's user-visible text must not return that row. Every id
   * (`nav-accounts`) and every group name that is not also a real word of the
   * row (`navigation`, `preferences`, `quickactions`, `settingspages`) is such
   * a query.
   */
  test('a row never answers a query absent from its own visible text', () => {
    const queries = new Set<string>();
    for (const item of menuRegistry) {
      queries.add(item.id);
      queries.add(item.group);
      queries.add(item.group.toLowerCase());
    }
    const blind: Array<{ query: string; row: string }> = [];
    for (const query of queries) {
      for (const row of allRows) {
        if (!matches(row, query)) continue;
        const visible = row.visible.join(' ').toLowerCase();
        if (!visible.includes(query.toLowerCase())) blind.push({ query, row: row.key });
      }
    }
    expect(blind).toEqual([]);
  });
});

// ============================================================================
// 3. Behaviour — the queries people actually type.
// ============================================================================

describe('queries return the rows they name', () => {
  test('"member" reaches BOTH rosters and NOT the account switcher', () => {
    // The reported bug. `nav-accounts` carried `members` in its keyword bag.
    // The answer used to be `proj-customize` — the project SETTINGS row, back
    // when its keyword bag was the concatenated vocabulary of thirteen pages.
    // There are two real rosters and each now owns the word: the workspace one
    // (the account hub's Access pane, pre-scoped to this workspace) and the
    // organization one.
    const result = hits('member');
    expect(result).toContain('nav:proj-members');
    expect(result).toContain('nav:account-members');
    expect(result).not.toContain('nav:nav-accounts');
    expect(hits('members')).not.toContain('nav:nav-accounts');
    // ...and the other row that DOES answer it still does.
    expect(result).toContain('nav:proj-invite');
  });

  test('"customize" returns one row, not seventeen', () => {
    // 12 settings tabs + 5 navigation rows carried the legacy `project
    // customize` tail. One row keeps the word, and it is the Customize INDEX
    // — the card grid that introduces every capability tab. It used to be the
    // Settings tab, i.e. one of the eight things that index introduces.
    expect(hits('customize')).toEqual(['nav:proj-customize']);
  });

  test('"project" returns the two rows that say the word, not every project-scoped row', () => {
    // `account-access-projects` is the account hub's "Projects" pane — the
    // word is its own label, which is exactly the bar this file sets. Ten
    // `proj-*` rows used to answer this by their ids.
    expect(hits('project').sort()).toEqual([
      'nav:account-access-projects',
      'nav:nav-projects',
    ]);
  });

  test('"proj" matches nothing by id', () => {
    // Ten `proj-*` rows used to answer this. The two that survive both carry
    // "Projects" as visible label text.
    expect(hits('proj').sort()).toEqual(['nav:account-access-projects', 'nav:nav-projects']);
  });

  test('"nav" and "pref" are not queries at all', () => {
    // `nav-projects`, `nav-accounts`; `pref-general`, `pref-appearance`, ...
    expect(hits('nav')).toEqual([]);
    expect(hits('pref').sort()).toEqual(['settings:preferences']);
  });

  test('"account" matches by word, never by group membership', () => {
    // The rule is structural: `group` is not part of the match text. It used
    // to be checkable by asserting that NO row in the `account` group contains
    // the word — which stopped being the right assertion when the eight
    // account sections came back as palette rows labelled "Account · X". They
    // contain the word because the user reads it on the row, which is exactly
    // what this file allows; a group name would be a word the user never sees.
    // So the check moved to where the word comes from: every matching row must
    // own it in its own label or keywords, never inherit it from the group.
    for (const item of menuRegistry) {
      const text = buildPaletteSearchText(item).toLowerCase();
      if (!text.includes('account')) continue;
      expect(`${item.label} ${item.keywords ?? ''}`.toLowerCase()).toContain('account');
    }
    const result = hits('account');
    // Every hit owns the word: the switcher, the nine "Account · X" sections,
    // "your account", "connected accounts".
    expect(result.sort()).toEqual([
      'nav:account-access-projects',
      'nav:account-audit',
      'nav:account-billing',
      'nav:account-branding',
      'nav:account-general',
      'nav:account-git',
      'nav:account-groups',
      'nav:account-help',
      'nav:account-identity',
      'nav:account-members',
      'nav:account-roles',
      'nav:account-tokens',
      'nav:account-usage',
      'nav:nav-accounts',
      'settings:connected',
      'settings:profile',
    ]);
  });

  test('the density submenu door answers the words a user would actually type', () => {
    // "i hate seeing so much text while kortix is thinking" — the row must be
    // reachable from the complaint's own vocabulary, not just its name. The row
    // is a door onto the palette's 'density' page (SUBMENU_PAGE_BY_ID), where
    // Normal and Minimal are picked explicitly. 'verbosity' stays a keyword:
    // it is the word the feature was asked for in, even though no UI says it.
    for (const query of ['density', 'verbosity', 'minimal', 'thinking', 'quiet']) {
      expect(hits(query)).toContain('nav:conversation-density');
    }
  });

  test('"view" matches the View group only where the word is really on screen', () => {
    const result = hits('view');
    expect(result).toContain('nav:view-changes'); // label "View Changes"
    expect(result).toContain('nav:toggle-panel-mode'); // label "Switch to Advanced View"
    expect(result).not.toContain('nav:toggle-sidebar');
    expect(result).not.toContain('nav:logout');
  });

  test('"actions" and "navigation" stop being wildcards for their groups', () => {
    expect(hits('navigation')).toEqual([]);
    // `open-session-audit` genuinely says "governed actions"; the account
    // Usage row says "transactions". The other nine rows of the `actions`
    // group said nothing of the sort and used to answer anyway.
    expect(hits('actions').sort()).toEqual(['nav:account-usage', 'nav:open-session-audit']);
    for (const key of ['nav:new-session', 'nav:compact-session', 'nav:view-changes']) {
      expect(hits('actions')).not.toContain(key);
    }
  });

  test('"apps" reaches the Apps page, not Connectors', () => {
    expect(hits('apps')).toEqual(['nav:proj-apps']);
  });

  test('"agents" and "skills" reach their pages, not a restart command', () => {
    expect(hits('agents')).not.toContain('nav:restart-config');
    expect(hits('agents')).toContain('nav:proj-agents');
    expect(hits('skills')).not.toContain('nav:restart-config');
    expect(hits('skills')).toContain('nav:proj-skills');
    // The Marketplace installs both and used to keep the words. It is a
    // section of `/projects/<id>/config` now, and that row deliberately drops
    // 'agents'/'skills': it would shadow the two rows above, which ARE those
    // pages, and `filteredNavItems` preserves declaration order rather than
    // ranking by relevance.
    expect(hits('skills')).toEqual(['nav:proj-skills']);
  });

  test('"sso" reaches Identity, not the account General section', () => {
    // Identity left the settings rail for `/accounts/[id]?tab=identity`; the
    // query has to follow it onto the registry row, and must still not drag
    // the account's General section in with it.
    expect(hits('sso')).toEqual(['nav:account-identity']);
  });

  test('"connections" reaches Connectors, not Channels', () => {
    expect(hits('connections')).toEqual(['nav:proj-connectors']);
  });

  test('"log" no longer drags Snapshots into an audit search', () => {
    expect(hits('log')).toContain('nav:account-audit');
    // Snapshots merged into the Sandbox templates section of
    // `/projects/<id>/config`. That row carries the word "snapshots" but
    // deliberately NOT "logs" — nor "catalog", which is why the Models row
    // does not carry that word either — so an audit search still does not drag
    // either of them in.
    expect(hits('log')).not.toContain('nav:proj-config-sandbox');
    expect(hits('log')).not.toContain('nav:proj-models');
    expect(hits('snapshots')).toEqual(['nav:proj-config-sandbox']);
  });
});

/**
 * The other half of the audit: the synonyms are load-bearing. Removing a
 * cross-concept word is only correct while every genuine alias still answers.
 * `command-palette.test.tsx` pins twenty-five of these on the settings side;
 * these are the navigation-side ones the same pass could have broken.
 */
describe('genuine synonyms still answer', () => {
  const KEPT: ReadonlyArray<[string, string]> = [
    ['shell', 'nav:open-session-terminal'],
    ['pty', 'nav:open-session-terminal'],
    ['connectors', 'nav:proj-connectors'],
    ['pipedream', 'nav:proj-connectors'],
    ['guardrails', 'nav:proj-connectors-policies'],
    ['teammate', 'nav:proj-invite'],
    ['subagents', 'nav:proj-agents'],
    ['abilities', 'nav:proj-skills'],
    ['drive', 'nav:proj-files'],
    ['threads', 'nav:proj-sessions'],
    ['organizations', 'nav:nav-accounts'],
    ['conflict', 'nav:sync-session-branch'],
    ['reconcile', 'nav:sync-session-branch'],
    ['restart', 'nav:restart-config'],
    ['deployments', 'nav:proj-apps'],
    ['signout', 'nav:logout'],
    // Was `settings:secrets`, then `nav:proj-customize` while Secrets' words
    // sat in that row's thirteen-page keyword bag. Secrets is its own
    // capability page (`/projects/<id>/secrets`) and has had its own row since
    // this change.
    ['env', 'nav:proj-secrets'],
    // Was `settings:schedules` / `settings:webhooks`. Both merged into one
    // Triggers capability page, so the row that answers these queries is a
    // single registry row now.
    ['cron', 'nav:proj-triggers'],
    ['recurring', 'nav:proj-triggers'],
    ['endpoint', 'nav:proj-triggers'],
    // `usage` left the overlay for `/accounts/[id]`, so its queries are
    // answered by a registry row. `api-keys` came BACK on 2026-08-18 as the
    // `tokens` tab (the personal half only), so `pat` reaches a settings row
    // again — `nav:account-tokens` answers for service account tokens.
    ['pat', 'settings:tokens'],
    ['hotkeys', 'settings:preferences'],
    ['ledger', 'nav:account-usage'],
    ['configure', 'nav:proj-customize'],
    // The rows this change added. Each was previously answered by
    // `proj-customize` — the Settings page — or by nothing at all.
    ['model', 'nav:proj-models'],
    ['gateway', 'nav:proj-models'],
    ['anthropic', 'nav:proj-models'],
    ['secret', 'nav:proj-secrets'],
    ['environment', 'nav:proj-secrets'],
    ['slack', 'nav:proj-channels'],
    ['agentmail', 'nav:proj-channels'],
    ['roster', 'nav:proj-members'],
    ['collaborators', 'nav:proj-members'],
    ['danger', 'nav:proj-config-general'],
    ['sandbox', 'nav:proj-config-sandbox'],
    ['approvals', 'nav:proj-config-review'],
    ['experimental', 'nav:proj-config-feature-flags'],
    ['labs', 'nav:proj-config-feature-flags'],
    ['migration', 'nav:proj-config-upgrades'],
    ['change requests', 'nav:review-changes'],
    ['github', 'nav:account-git'],
    ['grants', 'nav:account-access-projects'],
    ['permissions help', 'nav:account-help'],
  ];

  for (const [query, key] of KEPT) {
    test(`"${query}" still reaches ${key}`, () => {
      expect(hits(query)).toContain(key);
    });
  }
});
