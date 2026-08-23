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
 * The eight account-scoped tabs (Organization, Billing, Usage, Groups, Roles,
 * Identity, Audit log, API keys) are no longer in either list: they left the
 * overlay for `/accounts/[id]`, which runs its own two-tier width rule
 * (`max-w-3xl`, widening to `max-w-6xl` for the one section that is a wide
 * table). The rule this file enforces still governs everything that is
 * actually in the settings rail.
 *
 * The check that decides the tier reads the tab's SUBTREE, not just its own
 * file. Half these tabs are a container plus a slot, and the table lives in the
 * slot child. Counts below are `TABLE_MARKUP` matches / `<TableHead>` columns,
 * re-measured 2026-08-12: Audit's table is in `components/iam/audit-tab.tsx`
 * (17 / 5 — Event, Scope, Principal, Result, Time), Roles' in
 * `components/iam/roles-tab.tsx` (15 / 5), Api-keys' in
 * `components/iam/api-keys-card.tsx` (17 / 6; rewritten 2026-08-12, the table
 * used to live in the deleted `service-accounts-card.tsx`), Usage's in
 * `features/billing/transactions-table.tsx` (17 / 6), which
 * `features/billing/credit-transactions.tsx` mounts — see `CHILD_SUBTREE`.
 * Grepping only `settings/tabs/*.tsx` found a table in `members-tab.tsx` alone
 * (12 / 4) and read those four as card lists, which is how a 5-column audit log
 * nearly lost 224px of column. `TAB_SUBTREE` below is that missing hop, and the
 * test asserts each mapped child is really mounted so the map cannot rot into a
 * rubber stamp. (`members-tab.tsx` itself is no longer in the wide tier: it
 * graduated onto `CapabilityPageShell` and takes that shell's column now — the
 * subtree walk still guards every tab that IS in the rail.)
 *
 * This test exists because the rule is otherwise unenforceable: a new tab that
 * picks its own width compiles, renders, and passes every other test. Adding a
 * tab means adding it to one of the three lists below — deliberately, not by
 * copying whichever neighbour you happened to open first.
 *
 * Two tabs declare no width of their own, because `CapabilityPageShell`
 * supplies it; they are listed as such rather than omitted, so a future reader
 * can tell "delegates" apart from "forgotten".
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  projectSettingsSection,
  type ProjectSettingsSectionKey,
} from '@/features/workspace/capabilities/project-settings/project-settings-sections';

const TABS_DIR = join(import.meta.dir, 'tabs');
const SRC_DIR = join(import.meta.dir, '..', '..', '..');

/** Single-column settings. The design system's default container. */
const FORM_TABS = [
  'connected-tab.tsx',
  'experimental-tab.tsx',
  'general-tab.tsx',
  'preferences-tab.tsx',
  'profile-tab.tsx',
  'sandbox-tab.tsx',
  'snapshots-tab.tsx',
  // API keys: `AccessRow` list rows, not a `<Table>`, so it is a form tab.
  'tokens-tab.tsx',
];

/**
 * Real tables, which need the extra horizontal room.
 *
 * Empty since 2026-08-17, and deliberately kept rather than deleted: the tier
 * is still the rule, there is just nothing in the rail that qualifies today.
 * `members-tab.tsx` was its only member and left for `DELEGATING_TABS` when
 * Members graduated onto `CapabilityPageShell` — the shell's `max-w-5xl` was
 * that page's column then, so the tab declared no width at all. Members has
 * since graduated a FOURTH time, off the project entirely and onto the
 * account hub's Access tab (`/accounts/[id]?tab=access-projects`);
 * `/projects/[id]/members` is a bare redirect now and `members-tab.tsx` is
 * deleted, so nothing stands in for it in either tier or `DELEGATING_TABS`
 * below. A new rail tab that renders a real table belongs here, at
 * `max-w-4xl`.
 */
const TABLE_TABS: string[] = [];

/**
 * Declares no width of its own, because something else supplies the column.
 *
 * Renders `CapabilityPageShell` as its outermost element — it is a routed
 * Customize page (`/projects/[id]/models`) that happens to still live in
 * `tabs/`, not a pane in the settings rail. Its column is the shell's
 * `max-w-5xl`, shared with Connectors / Agents / Skills / Triggers / Secrets /
 * Channels, and it is pinned beside the file (`models-tab.test.tsx`) — not
 * here, because the panel's two-tier rule does not govern a page that is no
 * longer panel content.
 *
 * `members-tab.tsx` was the other entry until Members graduated a FOURTH
 * time (see the `TABLE_TABS` comment above) — `/projects/[id]/members` is a
 * bare redirect now, not a rendered pane, so there is nothing left here to
 * delegate a column for.
 */
const DELEGATING_TABS = ['models-tab.tsx'];

/** `<Table*>` markup — the ONLY thing that earns a tab the wide tier. */
const TABLE_MARKUP = /<Table(>|Header|Row|Body|Cell|Head\b)/;

/**
 * Content each tab mounts through a slot, src-relative. A tab whose body is a
 * container plus `{someSlot}` holds no markup of its own, so its tier is decided
 * here — see this file's header comment.
 */
const TAB_SUBTREE: Record<string, string[]> = {
  // Every entry that used to live here belonged to one of the eight
  // account-scoped tabs (`api-keys`, `audit`, `groups`, `identity`, `roles`,
  // `usage`, `billing`, `organization`). Those tabs left the overlay for
  // `/accounts/[id]` and their modules were deleted; the slot children
  // themselves (`components/iam/*`, `features/billing/*`) are untouched and
  // still mounted by that page, which sets its own column width per section.
  // Nothing left in this rail is a container-plus-slot, so the map is empty —
  // the `every mapped slot child is actually mounted by its tab` case below
  // keeps it that way rather than letting a stale entry rubber-stamp.
};

/**
 * A slot child that is itself a container plus a slot, so the walk needs one
 * more hop. Its only entry mapped `credit-transactions.tsx` ->
 * `transactions-table.tsx` for the Usage tab, which is gone; the hop is kept
 * as an empty map because the walk it feeds is still the right shape and the
 * next container-plus-slot tab will need it.
 */
const CHILD_SUBTREE: Record<string, string[]> = {};

function tabSource(file: string): string {
  return readFileSync(join(TABS_DIR, file), 'utf8');
}

function srcFile(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), 'utf8');
}

/** True when the mapped child renders a table itself OR through its own slot child. */
function childRendersTable(child: string): boolean {
  if (TABLE_MARKUP.test(srcFile(child))) return true;
  return (CHILD_SUBTREE[child] ?? []).some(childRendersTable);
}

/** True when the tab renders a table itself OR anywhere in its mapped subtree. */
function rendersTable(file: string): boolean {
  if (TABLE_MARKUP.test(tabSource(file))) return true;
  return (TAB_SUBTREE[file] ?? []).some(childRendersTable);
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

  // A THIRD width is the drift this file exists to stop, so the assertion is
  // "every width in use is one of the two tiers", not "both tiers are
  // populated". Set equality was the earlier form and it fails the moment a
  // tier empties — which `TABLE_TABS` did when Members graduated — for a
  // reason that has nothing to do with a tab picking its own width.
  test('no third width is in use across the whole panel', () => {
    const widths = new Set(
      [...FORM_TABS, ...TABLE_TABS].map((f) => firstContainerWidth(f)).filter(Boolean),
    );
    for (const width of widths) {
      expect(['max-w-2xl', 'max-w-4xl']).toContain(width);
    }
    // The rail is not empty, so neither is the evidence this test reads.
    expect(widths.size).toBeGreaterThan(0);
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

  // Same guard, one hop deeper: `CHILD_SUBTREE` is what keeps Usage in the wide
  // tier, so a pointer at a file `credit-transactions.tsx` no longer mounts would
  // make that tier a matter of taste again.
  test('every mapped grandchild is actually mounted by its slot child', () => {
    for (const [parent, children] of Object.entries(CHILD_SUBTREE)) {
      const source = srcFile(parent);
      for (const child of children) {
        expect(source).toContain(child.replace(/\.tsx$/, ''));
      }
    }
  });
});

/**
 * The panel does not only mount `tabs/*.tsx`. Secrets, Channels, Voice,
 * Upgrades and the gateway views are Customize sections that take their
 * container from `CustomizeSectionWrapper`. Those are settings panel content
 * too, so the same two-width rule governs them — a third width there is
 * exactly the drift this file exists to stop (the wrapper carried `max-w-3xl`
 * until 2026-08-12).
 *
 * `git-view.tsx` (Repositories) is not in either list below any more: it
 * merged INTO General as a "Git repo" section and now delegates to
 * `general-tab.tsx`'s own `max-w-2xl` column instead of declaring one of its
 * own — the same delegation `models-tab.tsx` does via `DELEGATING_TABS`
 * above, just for a section rather than a tab.
 */
/**
 * Empty since 2026-08-17, and kept rather than deleted: the rule still holds
 * for the next section that mounts the wrapper.
 *
 * `gateway-routing.tsx` was its last member and left the same way Secrets and
 * Channels did — it stopped being panel content. Routing is a tab of
 * `/projects/[id]/models` now, whose column is `CapabilityPageShell`'s
 * `max-w-5xl`, so the wrapper's `max-w-2xl` was not "the panel column" for it
 * any more but 320px narrower than the six tabs beside it, plus a second
 * scroll container inside the page's one. It writes its own section heading
 * (`RoutingSection`) and takes the page's column — pinned in
 * `settings/tabs/models-tab.test.tsx` with the rest of that page's chrome.
 */
const PANEL_SECTIONS_VIA_WRAPPER: string[] = [];

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
 *
 * The wrapper also nests a second scroll container inside the one
 * `settings-panel.tsx:524` already gives every pane, which this shape avoids.
 *
 * What is left in `PANEL_SECTIONS_VIA_WRAPPER` is not a pane at all: Routing is
 * a `TabsContent` panel inside `gateway-view.tsx`'s own sub-tab shell, under
 * the Models pane, whose heading `models-tab.tsx` already renders. It has no
 * rail entry and must not get one — the wrapper is the right shell for a
 * sub-view, and the width rule still applies to it. (Playground sat beside it
 * until the gateway bar was cut from ten tabs to six; that file is deleted.)
 */
const PANEL_SECTIONS_OWN_CONTAINER = [
  'features/workspace/customize/migrate-to-v2/upgrade-view.tsx',
  // `components/projects/schedule-view.tsx` was here until Schedules and
  // Webhooks graduated out of the settings overlay into their own capability
  // pages. It is no longer panel content, so the panel's two-width rule does
  // not govern it — the capability page that mounts it does.
  //
  // `secrets-view.tsx` left for the same reason and by the same route: it is
  // the body of `/projects/[id]/secrets`, it renders `CapabilityPageShell`,
  // and its column is that shell's `max-w-5xl` — pinned by
  // `customize/sections/view/secrets-view.chrome.test.ts`, not here.
  //
  // `channels-view.tsx` left on 2026-08-17 by a different door. It is not a
  // pane and not a page: it is `ChannelsSection`, the body of the Channels
  // scope of `/projects/[id]/connectors`, and the shell, the heading and the
  // scroll container all belong to `connectors-page.tsx` one level up. Its own
  // column is pinned by `customize/sections/view/channels-view.chrome.test.ts`
  // beside the file.
];

/**
 * Which of the sections above may resolve its heading through a registry.
 *
 * `SettingsTabHeader` is correct only for a pane whose id one of the two
 * registries actually knows. It returns `null` on a miss, and it takes the
 * pane's title, its description AND whatever `action` it was handed down with
 * it — silently, because nothing throws.
 *
 * Secrets shipped exactly that way. It graduated onto its own top-level
 * Customize tab and left both registries, so `/projects/[id]/secrets` rendered
 * no title, no description and no Add button. It writes its own heading now —
 * `CapabilityPageShell`'s `title`/`description` props, the same shell its four
 * sibling tabs use — and `secrets-view.chrome.test.ts` pins that it cannot
 * silently go back to the lookup.
 *
 * `channels-view.tsx` left both lists below on the same date and ended up
 * somewhere else again: it is a SECTION of the Connectors page now, not a
 * page, so it writes no heading at all. The heading it needs is the one
 * `connectors-page.tsx` swaps per scope. A registry lookup would have been the
 * wrong fix for it twice over.
 *
 * `git-view.tsx` left this list a different way: not a graduation, a merge.
 * Repositories folded INTO General as a "Git repo" section, so it dropped the
 * lookup and the container both — it is `general-tab.test.tsx`'s pane now.
 */
const PANES_WITH_REGISTRY_LOOKUP = ['features/workspace/customize/migrate-to-v2/upgrade-view.tsx'];

/**
 * The mirror image: a pane no registry answers for, where `SettingsTabHeader`
 * is not a style choice but a blank heading. This is the assertion that would
 * have caught Secrets shipping with no title, no description and no Add
 * button.
 *
 * Empty as of 2026-08-17, and kept rather than deleted because the failure it
 * describes is still live for the next pane that leaves a registry. Both of
 * its members left the panel entirely instead: Secrets became a capability
 * page on `CapabilityPageShell`, and Channels became a section of one. Each
 * has its heading pinned beside its own file — `secrets-view.chrome.test.ts`,
 * `channels-view.chrome.test.ts`. A pane that stays IN the panel and writes
 * its own heading belongs here.
 */
const PANES_WITH_OWN_HEADING: string[] = [];

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
   * The tabs the sections above render a heading for.
   *
   * `SettingsTabHeader` returns `null` when NEITHER registry it reads knows the
   * id, and renders no subtitle when the entry it finds has no `description`.
   * Both failures are silent — the pane just loses its heading and nothing
   * throws — which is exactly how the copy went missing on these panes in the
   * first place. This is the guard.
   *
   * These two ids resolve through the project-settings registry, not the
   * rail: both panes moved to `/projects/[id]/config` and their copy moved
   * with them. Secrets and Channels used to be in this list too — they
   * graduated a SECOND time, off this registry entirely and onto their own
   * top-level Customize tab, so they no longer have an entry here to pin.
   * Repositories left the same way Secrets and Channels did, but for a
   * different reason: not a graduation, a merge into General — it never had
   * its own heading to check once its content became a section of General's.
   */
  const PANES_WITH_REGISTRY_HEADING: ProjectSettingsSectionKey[] = ['upgrades'];

  for (const key of PANES_WITH_REGISTRY_HEADING) {
    test(`the '${key}' section entry carries the heading its pane renders`, () => {
      const item = projectSettingsSection(key);
      expect(item).toBeDefined();
      expect(item?.label ?? '').not.toBe('');
      expect(item?.description ?? '').not.toBe('');
    });
  }

  for (const relative of PANEL_SECTIONS_OWN_CONTAINER) {
    test(`${relative} declares the panel column itself`, () => {
      expect(srcFile(relative)).toContain('mx-auto w-full max-w-2xl');
    });
  }

  // The width is only half of why these left the wrapper. Without this, a
  // section could keep the column and quietly go back to hardcoding a title
  // and description the registry already owns — the exact drift that moved
  // Upgrades here. See the list's comment above.
  for (const relative of PANES_WITH_REGISTRY_LOOKUP) {
    test(`${relative} takes its heading from the registry, not a hardcoded string`, () => {
      const source = srcFile(relative);
      expect(source).toContain('<SettingsTabHeader');
      expect(source).not.toContain('<CustomizeSectionWrapper');
    });
  }

  for (const relative of PANES_WITH_OWN_HEADING) {
    test(`${relative} writes its own heading instead of a lookup that resolves to nothing`, () => {
      const source = srcFile(relative);
      expect(source).toContain('<SettingsSectionHeader');
      expect(source).not.toContain('<SettingsTabHeader');
      expect(source).not.toContain('<CustomizeSectionWrapper');
    });
  }
});
