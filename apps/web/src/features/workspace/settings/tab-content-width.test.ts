/**
 * The settings panel keeps ONE visual coordinate system: switching tabs must not
 * move the content column around.
 *
 * Before this test the 16 tabs used FOUR different widths — `max-w-lg`,
 * `max-w-2xl`, `max-w-4xl`, and a lone `max-w-6xl` on Usage. Going
 * Profile (32rem) -> Members (56rem) -> Usage (72rem) shifted the column by up
 * to 40rem. Every file was individually defensible; the set had no rule.
 *
 * Jay's call (2026-08-10): two tiers, one rule.
 *
 *   FORMS  `max-w-2xl` — single-column settings, the width the design system
 *          already prescribes (`.claude/skills/kortix-design-system/SKILL.md`,
 *          "Container: mx-auto w-full max-w-2xl").
 *   TABLES `max-w-4xl` — surfaces with a real table, which genuinely need the
 *          horizontal room.
 *
 * Jay's follow-up (2026-08-12): the rule was right, the classification was not.
 * Four tabs sat in the TABLE tier with no table anywhere in them — Sandbox,
 * Snapshots, Groups and Identity render card/row lists, so they were claiming
 * 896px of column they never used and pulling the eye sideways on every hop
 * from General. They now sit at `max-w-2xl` with the forms, and `max-w-2xl` is
 * the panel default — including for the Customize sections the panel mounts
 * (see the second describe block below).
 *
 * The check that decides the tier reads the tab's SUBTREE, not just its own
 * file. Half these tabs are a container plus a slot, and the table lives in the
 * slot child: Audit's is in `components/iam/audit-tab.tsx` (13 elements),
 * Roles' in `components/iam/roles-tab.tsx` (11), Api-keys' in
 * `components/iam/api-keys-card.tsx` (rewritten 2026-08-12; the table used to
 * live in the deleted `service-accounts-card.tsx`), Usage's in
 * `features/billing/credit-transactions.tsx` (15). Grepping only
 * `settings/tabs/*.tsx` finds a table in `members-tab.tsx` alone and reads those
 * four as card lists, which is how a 7-column audit log nearly lost 224px of
 * column. `TAB_SUBTREE` below is that missing hop, and the test asserts each
 * mapped child is really mounted so the map cannot rot into a rubber stamp.
 *
 * This test exists because the rule is otherwise unenforceable: a new tab that
 * picks its own width compiles, renders, and passes every other test. Adding a
 * tab means adding it to one of the two lists below — deliberately, not by
 * copying whichever neighbour you happened to open first.
 *
 * One tab delegates its container to a child view and so declares no width of
 * its own; it is listed as such rather than omitted, so a future reader can tell
 * "delegates" apart from "forgotten".
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

const TABS_DIR = join(import.meta.dir, 'tabs');
const SRC_DIR = join(import.meta.dir, '..', '..', '..');

/** Single-column settings. The design system's default container. */
const FORM_TABS = [
  'billing-tab.tsx',
  'connected-tab.tsx',
  'experimental-tab.tsx',
  'general-tab.tsx',
  'groups-tab.tsx',
  'identity-tab.tsx',
  'organization-tab.tsx',
  'preferences-tab.tsx',
  'profile-tab.tsx',
  'sandbox-tab.tsx',
  'snapshots-tab.tsx',
];

/** Real tables, which need the extra horizontal room. */
const TABLE_TABS = [
  'api-keys-tab.tsx',
  'audit-tab.tsx',
  'members-tab.tsx',
  'roles-tab.tsx',
  'usage-tab.tsx',
];

/** Render a child view that brings its own container, so they declare no width. */
const DELEGATING_TABS = ['models-tab.tsx'];

/** `<Table*>` markup — the ONLY thing that earns a tab the wide tier. */
const TABLE_MARKUP = /<Table(>|Header|Row|Body|Cell|Head\b)/;

/**
 * Content each tab mounts through a slot, src-relative. A tab whose body is a
 * container plus `{someSlot}` holds no markup of its own, so its tier is decided
 * here — see this file's header comment.
 */
const TAB_SUBTREE: Record<string, string[]> = {
  'api-keys-tab.tsx': ['components/iam/api-keys-card.tsx', 'components/iam/key-rules-card.tsx'],
  'audit-tab.tsx': ['components/iam/audit-tab.tsx', 'components/iam/audit-webhooks-card.tsx'],
  'groups-tab.tsx': ['components/iam/groups-tab.tsx'],
  'identity-tab.tsx': [
    'components/iam/identity-intro.tsx',
    'components/iam/scim-card.tsx',
    'components/iam/sso-card.tsx',
  ],
  'roles-tab.tsx': ['components/iam/roles-tab.tsx'],
  'usage-tab.tsx': [
    'features/billing/cost-explorer/cost-explorer.tsx',
    'features/billing/credit-transactions.tsx',
  ],
};

function tabSource(file: string): string {
  return readFileSync(join(TABS_DIR, file), 'utf8');
}

/** True when the tab renders a table itself OR through a slot child. */
function rendersTable(file: string): boolean {
  if (TABLE_MARKUP.test(tabSource(file))) return true;
  return (TAB_SUBTREE[file] ?? []).some((child) =>
    TABLE_MARKUP.test(readFileSync(join(SRC_DIR, child), 'utf8')),
  );
}

function firstContainerWidth(file: string): string | null {
  const source = tabSource(file);
  // Only the outermost `mx-auto w-full max-w-*` counts — inner `max-w-*` on a
  // paragraph or a field is a different concern and must not be picked up.
  const match = source.match(/mx-auto w-full (max-w-[a-z0-9]+)/);
  return match ? match[1] : null;
}

// NOTE: deliberately plain `for … of` + `test()`, not `test.each`. `test.each`
// is what produces this app's known ~17-error `@types/bun` tsc baseline (see
// the root CLAUDE.md); adding a fourth such file raised that baseline to 23 and
// weakened the "exactly 17" gate every task in this effort is measured against.
// The loop costs one line and keeps the gate meaningful.
describe('settings tab content width', () => {
  for (const file of FORM_TABS) {
    test(`${file} is a form tab at max-w-2xl`, () => {
      expect(firstContainerWidth(file)).toBe('max-w-2xl');
    });
  }

  for (const file of TABLE_TABS) {
    test(`${file} is a table tab at max-w-4xl`, () => {
      expect(firstContainerWidth(file)).toBe('max-w-4xl');
    });
  }

  for (const file of DELEGATING_TABS) {
    test(`${file} delegates its container to a child view`, () => {
      expect(firstContainerWidth(file)).toBeNull();
    });
  }

  test('every tab file is classified — a new tab cannot silently pick its own width', () => {
    const onDisk = readdirSync(TABS_DIR)
      .filter((f) => f.endsWith('-tab.tsx') && !f.endsWith('.test.tsx'))
      .sort();
    const classified = [...FORM_TABS, ...TABLE_TABS, ...DELEGATING_TABS].sort();
    expect(onDisk).toEqual(classified);
  });

  test('only two widths are in use across the whole panel', () => {
    const widths = new Set(
      [...FORM_TABS, ...TABLE_TABS].map((f) => firstContainerWidth(f)).filter(Boolean),
    );
    expect([...widths].sort()).toEqual(['max-w-2xl', 'max-w-4xl']);
  });

  // The wide tier is not a matter of taste: it is "this tab renders a table",
  // in its own file or in the slot child it mounts. Without this, the four tabs
  // moved down to `max-w-2xl` on 2026-08-12 can drift back up one at a time,
  // each with its own local justification.
  test('the wide tier is exactly the tabs that render a table', () => {
    const wide = [...FORM_TABS, ...TABLE_TABS].filter(rendersTable).sort();
    expect(wide).toEqual([...TABLE_TABS].sort());
  });

  // `TAB_SUBTREE` decides four of the five wide tabs, so a stale entry silently
  // turns the test above into a rubber stamp: point it at a file the tab no
  // longer mounts and the tier stops being evidence-based. `readFileSync` covers
  // "the child was deleted"; this covers "the child is no longer mounted here".
  test('every mapped slot child is actually mounted by its tab', () => {
    for (const [tab, children] of Object.entries(TAB_SUBTREE)) {
      const source = tabSource(tab);
      for (const child of children) {
        expect(source).toContain(child.replace(/\.tsx$/, ''));
      }
    }
  });
});

/**
 * The panel does not only mount `tabs/*.tsx`. Secrets, Channels, Schedules,
 * Webhooks, Voice, Upgrades and the gateway views are Customize sections that
 * take their container from `CustomizeSectionWrapper`, and Repositories brings
 * its own. Those are settings panel content too, so the same two-width rule
 * governs them — a third width there is exactly the drift this file exists to
 * stop (the wrapper carried `max-w-3xl` until 2026-08-12).
 */
const PANEL_SECTIONS_VIA_WRAPPER = [
  'features/workspace/customize/sections/view/gateway/gateway-routing.tsx',
  'features/workspace/customize/sections/view/gateway/gateway-playground.tsx',
];

/**
 * Panel sections that declare their own container instead of the wrapper's.
 *
 * Every one takes `SettingsTabHeader`, so the pane's title and description come
 * from the tab's rail entry — the same single source every `tabs/*.tsx` pane
 * reads. `CustomizeSectionWrapper` cannot: it takes `title`/`description` as
 * props, so a section using it has to restate copy that already exists in
 * `rail.ts`, and the two drift. Every pane that used it did drift:
 *
 * | Pane | What it had |
 * | --- | --- |
 * | Upgrades | THREE wordings of one sentence — the wrapper's, the rail's, and a `<p>` in its own body — and rendered the two that were not canonical |
 * | Voice | Two: a three-sentence local one that rendered, and the rail's, which never did |
 * | Secrets, Channels | A local description; their rail entries had none at all |
 * | Schedules, Webhooks | Both in `KIND_COPY.title`/`.description` — a screen-copy table that also owned a pane heading |
 *
 * The wrapper also nests a second scroll container inside the one
 * `settings-panel.tsx:524` already gives every pane, which this shape avoids.
 *
 * What is left in `PANEL_SECTIONS_VIA_WRAPPER` is not a pane at all: Routing
 * and Playground are `TabsContent` panels inside `gateway-view.tsx`'s own
 * sub-tab shell, under the Models pane, whose heading `models-tab.tsx` already
 * renders. They have no rail entry and must not get one — the wrapper is the
 * right shell for a sub-view, and the width rule still applies to them.
 */
const PANEL_SECTIONS_OWN_CONTAINER = [
  'features/workspace/customize/sections/view/git-view.tsx',
  'features/workspace/customize/migrate-to-v2/upgrade-view.tsx',
  'features/workspace/customize/sections/view/secrets-view.tsx',
  'features/workspace/customize/sections/view/channels-view.tsx',
  'features/workspace/customize/sections/view/voice-view.tsx',
  'components/projects/schedule-view.tsx',
];

function srcFile(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), 'utf8');
}

describe('customize sections mounted in the settings panel', () => {
  test('the shared wrapper defaults to the panel column, not a third width', () => {
    const wrapper = srcFile('features/workspace/customize/sections/component/section-wrapper.tsx');
    expect(wrapper).toContain('mx-auto w-full max-w-2xl');
    expect(wrapper).not.toContain('mx-auto w-full max-w-3xl');
  });

  for (const relative of PANEL_SECTIONS_VIA_WRAPPER) {
    test(`${relative} takes the wrapper's column unchanged`, () => {
      const source = srcFile(relative);
      // Guard against this test quietly becoming unfalsifiable: if the view stops
      // mounting the wrapper (renamed, refactored, deleted), the width assertion
      // below would pass on a file that no longer has a container at all.
      expect(source).toContain('<CustomizeSectionWrapper');
      // A `className` handed to the wrapper wins over its base width (twMerge),
      // so a `max-w-*` in the props of that element is an override.
      const props = source.slice(source.indexOf('<CustomizeSectionWrapper'));
      const firstElement = props.slice(0, props.indexOf('>'));
      expect(firstElement).not.toMatch(/max-w-/);
    });
  }

  /**
   * The tabs the sections above render a heading for. `schedule-view.tsx` is
   * one component serving two, switched by its `type` prop.
   *
   * `SettingsTabHeader` returns `null` when `railItemForTab` finds nothing, and
   * renders no subtitle when the entry it finds has no `description`. Both
   * failures are silent — the pane just loses its heading and nothing throws —
   * which is exactly how the copy went missing on these panes in the first
   * place. This is the guard.
   */
  const PANES_WITH_RAIL_HEADING: SettingsTab[] = [
    'repositories',
    'upgrades',
    'secrets',
    'channels',
    'voice',
    'schedules',
    'webhooks',
  ];

  for (const tab of PANES_WITH_RAIL_HEADING) {
    test(`the '${tab}' rail entry carries the heading its pane renders`, () => {
      const item = railItemForTab(tab);
      expect(item).toBeDefined();
      expect(item?.label ?? '').not.toBe('');
      expect(item?.description ?? '').not.toBe('');
    });
  }

  for (const relative of PANEL_SECTIONS_OWN_CONTAINER) {
    test(`${relative} declares the panel column itself`, () => {
      expect(srcFile(relative)).toContain('mx-auto w-full max-w-2xl');
    });

    // The width is only half of why these two left the wrapper. Without this,
    // a section could keep the column and quietly go back to hardcoding a
    // title and description the rail already owns — the exact drift that moved
    // Upgrades here. See the list's comment above.
    test(`${relative} takes its heading from the rail, not a hardcoded string`, () => {
      const source = srcFile(relative);
      expect(source).toContain('<SettingsTabHeader');
      expect(source).not.toContain('<CustomizeSectionWrapper');
    });
  }
});
