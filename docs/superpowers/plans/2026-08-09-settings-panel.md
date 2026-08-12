# Settings panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Kortix's three settings surfaces into one full-screen overlay built on a vertical `Tabs` list, and delete `app/(app)/accounts/**`.

**Architecture:** One `<Tabs orientation="vertical">` wraps both columns of the existing full-screen `Modal`. `TabsList` renders in the 250px left rail; `TabsContent` renders in the pane. A single `SettingsSectionHeader` primitive renders every section header. Tab visibility keeps the current fail-open IAM probe. Content moves tab-by-tab; each phase leaves the app working.

**Tech Stack:** Next.js (see `apps/web/AGENTS.md` — read `node_modules/next/dist/docs/` before writing route code), React 19, Radix `@radix-ui/react-tabs`, TanStack Query, Zustand, Tailwind v4, `@kortix/sdk`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-09-settings-panel-design.md`
**Linear:** https://linear.app/sutharjay/project/settings-panel-6323b30fb099

## Global Constraints

- Work stays on branch `settings` in worktree `/Users/jay/root/kortix/suna-settings`. Do not create a worktree.
- Do **not** commit unless the user asks. Steps below say "Commit" — pause and ask before running them.
- No Linear identifier or `linear.app` URL in any branch name, commit message, PR title, or PR body.
- `features/layout/user-menu.tsx` is not restructured. Only `account-settings-modal-store`'s target changes.
- No API changes. Every tab is served by an endpoint that exists today.
- Tests are co-located `*.test.ts` / `*.test.tsx` using `bun:test`. Run with `bun test <path>` from `apps/web`.
- **There is no DOM in `bun test`.** `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `happy-dom`, and `jsdom` are all absent from `apps/web`, and `test-setup.ts` registers no DOM global — it only scrubs dotenvx ciphertext from `process.env`. **Do not add any of them**; a DOM test environment for a 3,000-file Next app is a repo-wide decision, not a side effect of this feature.
  - **Render assertions** use `renderToStaticMarkup` from `react-dom/server` and assert on the returned HTML string. This is the established idiom — see `features/workspace/customize/migrate-to-v2/migrate-to-v2-button.test.tsx`. Radix emits `role`, `aria-orientation`, `aria-controls`, `aria-labelledby`, `aria-selected`, `data-slot`, and every className into SSR output, so class, ARIA, ordering, and presence/absence assertions all work.
  - **Logic assertions** go in a pure function with its own `.test.ts`, called by the component. Prefer extracting the branching logic over trying to reach it through markup.
  - **Interaction** — click, type, keyboard roving, focus, theme switching — cannot be tested here. Put those assertions in the Playwright harness (`pnpm --filter web test:e2e`, specs under `apps/web/e2e/`) and say so in the task's report rather than silently dropping the coverage.
  - A component that needs React Query, a router, or a Zustand store to render will throw under `renderToStaticMarkup`. Split a pure presentational sub-component out and test that — the codebase already does this (`MigrateToV2ButtonView` beside `MigrateToV2Button`).
- Icons come from `@phosphor-icons/react` with a local alias, matching `rail.ts`.
- Never use a spinner icon for loading; use the `Loading` component (`@/components/ui/loading`).
- Tab visibility is a **visibility layer, not a security boundary**. It fails open: loading and errored probes render the full rail.
- **Every tab pane is always mounted — inactive ones only carry `hidden`.** Verified in `@radix-ui/react-presence`: `TabsContent` passes `children` as a function, `Presence` sets `const forceMount = typeof children === 'function'`, and `return forceMount || presence.isPresent ? clone : null` therefore never reaches `null`. This is real client behaviour, not an SSR artifact. **So a pane must NOT fetch on mount** — gate every tab's queries on that tab being active, or opening the panel fires 26 tabs' worth of requests at once. This applies to every tab task in phases 2–4.
- Read `.claude/skills/kortix-design-system/SKILL.md` before touching any visual surface.

## File structure

**New files**

| Path | Responsibility |
| --- | --- |
| `src/features/workspace/settings/settings-tabs.ts` | The `SettingsTab` union, group definitions, legacy redirect map. Replaces `lib/customize-sections.ts`. |
| `src/features/workspace/settings/rail.ts` | Five rail groups + flag composition. Replaces `customize/rail.ts`. |
| `src/features/workspace/settings/settings-panel.tsx` | The overlay shell wired to `Tabs`. Replaces `customize-panel.tsx`. |
| `src/components/ui/settings-section-header.tsx` | The one title/description/action block. |
| `src/features/workspace/settings/tabs/*.tsx` | One file per tab pane. |

**Modified**

| Path | Change |
| --- | --- |
| `src/components/ui/tabs.tsx` | Add an additive vertical list variant. |
| `src/stores/customize-store.ts` | Rename to `settings-panel-store.ts`; `section` → `tab`. |
| `src/stores/account-settings-modal-store.ts` | Open the panel instead of `window.location.href`. |
| `src/lib/menu-registry.ts` | Repoint `proj-*` hrefs at `/settings/*`. |

**Deleted (phase 3)**

`src/app/(app)/accounts/**`, `src/features/accounts/settings/side-panel-user-settings.tsx`.

---

# Phase 1 — Shell and primitives

Nothing moves. Every existing surface keeps working, rendered through the new shell.

### Task 1: Vertical list variant for `tabs.tsx`

**Files:**
- Modify: `apps/web/src/components/ui/tabs.tsx`
- Test: `apps/web/src/components/ui/tabs.vertical.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<TabsList orientation="vertical">` renders `flex-col`, full-width triggers, left-aligned text, and no `SlidingTabIndicator`. `Tabs` already forwards `orientation` to Radix.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const html = (orientation: 'horizontal' | 'vertical') =>
  renderToStaticMarkup(
    <Tabs defaultValue="a" orientation={orientation}>
      <TabsList orientation={orientation}>
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b">Beta</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Alpha pane</TabsContent>
    </Tabs>,
  );

/** The className string of the element carrying data-slot="tabs-list". */
const listClasses = (out: string): string =>
  out.match(/<div[^>]*data-slot="tabs-list"[^>]*class="([^"]*)"/)?.[1] ?? '';

describe('TabsList orientation', () => {
  test('vertical lists stack and fill their column', () => {
    const out = html('vertical');
    expect(out).toContain('aria-orientation="vertical"');
    expect(listClasses(out)).toContain('flex-col');
    expect(listClasses(out)).toContain('w-full');
  });

  test('vertical lists render no sliding indicator', () => {
    expect(html('vertical')).not.toContain('data-slot="tabs-indicator"');
  });

  test('horizontal lists keep their orientation and do not stack', () => {
    const out = html('horizontal');
    expect(out).toContain('aria-orientation="horizontal"');
    expect(listClasses(out)).not.toContain('flex-col');
  });

  test('the list and the pane are wired together for assistive tech', () => {
    const out = html('vertical');
    expect(out).toContain('aria-controls=');
    expect(out).toContain('aria-labelledby=');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('aria-selected="true"');
  });

  test('only the active pane is rendered', () => {
    expect(html('vertical').match(/role="tabpanel"/g)).toHaveLength(1);
  });
});
```

If `listClasses` returns an empty string, read the real SSR output first
(`console.log(html('vertical'))`) and fix the matcher against what Radix
actually emits — do not weaken the assertion to make it pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/components/ui/tabs.vertical.test.tsx`
Expected: FAIL — `TabsList` does not accept `orientation`, so `flex-col` is absent.

- [ ] **Step 3: Implement the vertical variant**

In `tabs.tsx`, add an `orientation` prop to `TabsList`, default `'horizontal'`. When vertical:
- container classes become `flex w-full flex-col items-stretch gap-0.5 h-auto rounded-none bg-transparent p-0`
- skip rendering `SlidingTabIndicator` entirely — it measures on the x-axis and produces a zero-width bar in a column
- triggers get `w-full justify-start text-left`

Gate every new class behind the vertical branch. Do not touch `tabsListHeightClasses`, `tabsTriggerPaddingVariants`, `tabsTriggerTextVariants`, or the `default`/`underline` list types — horizontal callers must render byte-identically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/components/ui/tabs.vertical.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove no horizontal caller regressed**

Run: `cd apps/web && bun test src/ 2>&1 | tail -20`
Expected: no new failures versus the pre-change baseline. Capture the baseline first with the same command on a clean tree.

- [ ] **Step 6: Commit** (ask first)

```bash
git add apps/web/src/components/ui/tabs.tsx apps/web/src/components/ui/tabs.vertical.test.tsx
git commit -m "feat(ui): add a vertical list variant to Tabs"
```

---

### Task 2: `SettingsSectionHeader` primitive

**Files:**
- Create: `apps/web/src/components/ui/settings-section-header.tsx`
- Test: `apps/web/src/components/ui/settings-section-header.test.tsx`
- Modify: `apps/web/src/features/workspace/customize/sections/component/section-wrapper.tsx` — its internal `heading` block is replaced by this component (both the `fill` and default render paths share that block)
- Test: `apps/web/src/features/workspace/customize/sections/component/section-wrapper.test.tsx`
- Modify: `apps/web/src/app/globals.css` — only if `--foreground-strong` / `--foreground-weak` are missing

**Interfaces:**
- Consumes: nothing.
- Produces: `SettingsSectionHeader({ title, description?, action?, className? }): JSX.Element`. Every tab pane in phases 2–4 uses it.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSectionHeader } from './settings-section-header';

describe('SettingsSectionHeader', () => {
  test('renders the title as an h2', () => {
    expect(renderToStaticMarkup(<SettingsSectionHeader title="Name and icon" />)).toContain(
      '>Name and icon</h2>',
    );
  });

  test('renders the description when given', () => {
    expect(
      renderToStaticMarkup(
        <SettingsSectionHeader title="Name" description="How this workspace appears." />,
      ),
    ).toContain('How this workspace appears.');
  });

  test('omits the description element entirely when not given', () => {
    expect(renderToStaticMarkup(<SettingsSectionHeader title="Name" />)).not.toContain('<p');
  });

  test('omits the action wrapper entirely when not given', () => {
    const out = renderToStaticMarkup(<SettingsSectionHeader title="Name" />);
    expect(out).not.toContain('sm:justify-end');
  });

  test('renders the action', () => {
    expect(
      renderToStaticMarkup(
        <SettingsSectionHeader title="Delete" action={<button type="button">Delete</button>} />,
      ),
    ).toContain('<button type="button">Delete</button>');
  });

  test('caps the description measure at the specified width', () => {
    expect(
      renderToStaticMarkup(<SettingsSectionHeader title="N" description="D" />),
    ).toContain('max-w-[410px]');
  });

  test('keeps the specified responsive layout on the outer row', () => {
    const out = renderToStaticMarkup(<SettingsSectionHeader title="N" />);
    for (const cls of ['sm:flex-row', 'sm:items-center', 'sm:justify-between']) {
      expect(out).toContain(cls);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/components/ui/settings-section-header.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The one section header used across the Settings panel: title on the left,
 * optional description under it, one action on the right. Destructive rows use
 * this same component with a destructive-variant button in `action` — there is
 * no separate danger-zone header.
 */
export function SettingsSectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 text-base">
        <h2 className="font-regular text-foreground-strong text-base">{title}</h2>
        {description ? (
          <p className="font-regular text-foreground-weak max-w-[410px] text-sm">{description}</p>
        ) : null}
      </div>
      {action ? (
        <div className="flex w-full min-w-0 items-center gap-4 sm:w-auto sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/components/ui/settings-section-header.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the tokens resolve**

Run: `cd apps/web && grep -n "foreground-strong\|foreground-weak" src/app/globals.css`
Expected: both tokens are defined. If either is missing, add it to `globals.css` following the neighbouring token definitions and re-run. Do **not** substitute `text-foreground` / `text-muted-foreground` — the spec's markup is the user's, verbatim.

- [ ] **Step 6: Commit** (ask first)

---

### Task 3: The tab enum and the legacy redirect map

**Files:**
- Create: `apps/web/src/features/workspace/settings/settings-tabs.ts`
- Create: `apps/web/src/features/workspace/settings/settings-tabs.test.ts`
- Modify: `apps/web/src/lib/customize-sections.ts` — becomes a re-export shim

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SettingsTab` — the 27 tab ids
  - `const SETTINGS_TABS: readonly SettingsTab[]`
  - `const DEFAULT_SETTINGS_TAB: SettingsTab`
  - `parseSettingsTab(raw: string | null | undefined): SettingsTab | null`
  - `legacySectionRedirect(projectId: string, rawSection: string): string | null`
  - `resolveSettingsOverlayHref(href: string): { opensOverlay: true; tab: SettingsTab | undefined } | { opensOverlay: false }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  legacySectionRedirect,
  parseSettingsTab,
  resolveSettingsOverlayHref,
} from './settings-tabs';

describe('SETTINGS_TABS', () => {
  test('holds every tab exactly once', () => {
    expect(new Set(SETTINGS_TABS).size).toBe(SETTINGS_TABS.length);
  });

  test('the default tab is a real tab', () => {
    expect(SETTINGS_TABS).toContain(DEFAULT_SETTINGS_TAB);
  });

  test('carries the tabs the spec names', () => {
    for (const tab of [
      'profile', 'preferences', 'connected',
      'general', 'members', 'secrets', 'channels', 'repositories',
      'schedules', 'webhooks', 'computers',
      'models', 'instructions', 'marketplace', 'review', 'voice', 'sandbox', 'snapshots',
      'billing', 'usage', 'groups', 'roles', 'identity', 'audit',
      'api-keys', 'experimental', 'upgrades',
    ]) {
      expect(SETTINGS_TABS).toContain(tab as never);
    }
  });
});

describe('parseSettingsTab', () => {
  test('accepts a known tab', () => {
    expect(parseSettingsTab('members')).toBe('members');
  });

  test('rejects an unknown segment', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab(null)).toBeNull();
    expect(parseSettingsTab('')).toBeNull();
  });
});

describe('legacySectionRedirect', () => {
  test('commands folds into instructions', () => {
    expect(legacySectionRedirect('p1', 'commands')).toBe('/projects/p1/settings/instructions');
  });

  test('the old settings section becomes general', () => {
    expect(legacySectionRedirect('p1', 'settings')).toBe('/projects/p1/settings/general');
  });

  test('git becomes repositories', () => {
    expect(legacySectionRedirect('p1', 'git')).toBe('/projects/p1/settings/repositories');
  });

  test('graduated capability pages still leave the overlay', () => {
    expect(legacySectionRedirect('p1', 'skills')).toBe('/projects/p1/skills');
    expect(legacySectionRedirect('p1', 'agents')).toBe('/projects/p1/agent');
    expect(legacySectionRedirect('p1', 'connectors')).toBe('/projects/p1/connectors');
    expect(legacySectionRedirect('p1', 'files')).toBe('/projects/p1/files');
  });

  test('every llm sub-section lands on models', () => {
    for (const s of ['llm-management', 'llm-overview', 'llm-providers', 'llm-logs', 'llm-budgets', 'llm-keys', 'llm-api']) {
      expect(legacySectionRedirect('p1', s)).toBe('/projects/p1/settings/models');
    }
  });

  test('an unknown section produces no redirect', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });
});

describe('resolveSettingsOverlayHref', () => {
  test('a bare settings href opens the default tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings')).toEqual({
      opensOverlay: true,
      tab: undefined,
    });
  });

  test('a named tab opens that tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/members')).toEqual({
      opensOverlay: true,
      tab: 'members',
    });
  });

  test('an unresolvable segment does not open the overlay', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/skills')).toEqual({
      opensOverlay: false,
    });
  });

  test('a non-settings href does not open the overlay', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/files')).toEqual({ opensOverlay: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/workspace/settings/settings-tabs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `settings-tabs.ts`**

Port the structure of `lib/customize-sections.ts`. The union becomes the 27 ids listed in the test. `DEFAULT_SETTINGS_TAB` is `'general'` — it survives every flag and is the tab the panel is most often opened for.

`legacySectionRedirect` merges the two old maps into one: the `GRADUATED` capability-page map (`files`, `changes`, `agent`, `agents`, `connectors`, `skills`) **plus** a rename map for sections that stayed but changed id (`commands`→`instructions`, `settings`→`general`, `git`→`repositories`, `tokens`→`api-keys`, `transactions`→`usage`, and every `llm-*`→`models`). A section whose id is unchanged returns its own `/settings/<id>` path.

Keep the existing doc comment explaining **why** an unresolvable segment must return `opensOverlay: false` — `openSettings(undefined)` would otherwise silently reopen the panel on the last-viewed tab instead of navigating.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/features/workspace/settings/settings-tabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Freeze `lib/customize-sections.ts` as legacy vocabulary — do NOT alias it**

**Corrected 2026-08-09 after this step failed in practice.** The original instruction
said to replace the body with re-exports of the new names. That is not a shim, it is a
breaking rename: the new union does not contain `git`, `commands`, `settings`,
`llm-management`, or `upgrade`, so all 13 remaining callers stop compiling.
`tsc --noEmit` went from 17 errors to 61.

Instead: **leave the file's original union and behaviour exactly as they are.** The two
vocabularies coexist until Task 5 rewires the panel and deletes this file. Add a header
comment stating that this is frozen legacy vocabulary, that
`features/workspace/settings/settings-tabs.ts` is the new source of truth, and that the
file dies in Task 5 — so nobody "helpfully" aliases the two.

Keep `lib/customize-sections.test.ts` and its cases. They are not obsolete while the
legacy vocabulary is still live.

- [ ] **Step 6: Verify nothing broke**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -30`
Expected: no new errors beyond the ~15 known `@types/bun` ones.

- [ ] **Step 7: Commit** (ask first)

---

### Task 4: Regroup the rail into five groups

**Files:**
- Create: `apps/web/src/features/workspace/settings/rail.ts`
- Create: `apps/web/src/features/workspace/settings/rail.test.ts`
- Create: `apps/web/src/features/workspace/settings/type.ts` — `RailItem` / `RailGroup` keyed on `tab`
- **Leave `apps/web/src/features/workspace/customize/rail.ts` and `type.ts` untouched**

> **Do NOT make the old rail a re-export shim.** This is the same trap Task 3 hit: the
> legacy `RailItem` is keyed on `section` with the OLD ids, the new one is keyed on `tab`
> with the NEW ids. Aliasing them breaks `customize-panel.tsx` and `rail.test.ts`, which
> are still live until Task 5. The two rails coexist; the legacy one is deleted in Task 5
> along with `customize-panel.tsx` and `lib/customize-sections.ts`.
>
> Gate: `npx tsc --noEmit 2>&1 | grep -c "error TS"` must still return **17** when this
> task ends.

**Interfaces:**
- Consumes: `SettingsTab` from Task 3.
- Produces:
  - `interface RailFlags { tunnelEnabled; marketplaceEnabled; llmGatewayAvailable; voiceEnabled; reviewEnabled }`
  - `railGroups(flags: RailFlags): readonly RailGroup[]` — five groups in order You, Workspace, Agent, Organization, Developer
  - `isRailItemActive(item: RailItem, tab: SettingsTab): boolean`
  - `const UPGRADE_ITEM: RailItem`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { type RailFlags, isRailItemActive, railGroups } from './rail';
import type { RailItem } from './type';

const item = (tab: RailItem['tab']): RailItem => ({ tab, label: tab });

const flags = (overrides: Partial<RailFlags> = {}): RailFlags => ({
  tunnelEnabled: false,
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
  ...overrides,
});

const tabsOf = (f: RailFlags): string[] => railGroups(f).flatMap((g) => g.items.map((i) => i.tab));

describe('railGroups', () => {
  test('renders the five groups in order', () => {
    expect(railGroups(flags()).map((g) => g.label)).toEqual([
      'You', 'Workspace', 'Agent', 'Organization', 'Developer',
    ]);
  });

  test('with every flag off it holds the static tabs only', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('profile');
    expect(tabs).toContain('channels');
    expect(tabs).toContain('billing');
    expect(tabs).not.toContain('computers');
    expect(tabs).not.toContain('voice');
    expect(tabs).not.toContain('review');
    expect(tabs).not.toContain('marketplace');
  });

  test('each flag adds exactly its own tab', () => {
    expect(tabsOf(flags({ tunnelEnabled: true }))).toContain('computers');
    expect(tabsOf(flags({ voiceEnabled: true }))).toContain('voice');
    expect(tabsOf(flags({ reviewEnabled: true }))).toContain('review');
    expect(tabsOf(flags({ marketplaceEnabled: true }))).toContain('marketplace');
  });

  test('two flags in one group both land — the rail.ts:110 regression', () => {
    const tabs = tabsOf(flags({ marketplaceEnabled: true, reviewEnabled: true, voiceEnabled: true }));
    expect(tabs).toContain('marketplace');
    expect(tabs).toContain('review');
    expect(tabs).toContain('voice');
  });

  test('every flag on yields 26 content tabs', () => {
    const all = flags({
      tunnelEnabled: true, marketplaceEnabled: true,
      llmGatewayAvailable: true, voiceEnabled: true, reviewEnabled: true,
    });
    expect(tabsOf(all)).toHaveLength(26);
  });

  test('no tab appears in two groups', () => {
    const tabs = tabsOf(flags({ tunnelEnabled: true, marketplaceEnabled: true, voiceEnabled: true, reviewEnabled: true }));
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  test('upgrades is not in the scrolling groups — it is pinned', () => {
    expect(tabsOf(flags())).not.toContain('upgrades');
  });
});

describe('isRailItemActive', () => {
  test('an item matches its own tab', () => {
    expect(isRailItemActive(item('members'), 'members')).toBe(true);
    expect(isRailItemActive(item('members'), 'secrets')).toBe(false);
  });

  test('models stands in for every llm sub-tab', () => {
    expect(isRailItemActive(item('models'), 'models')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-logs')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-budgets')).toBe(true);
    expect(isRailItemActive(item('models'), 'members')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/workspace/settings/rail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Five static groups. Flag-gated items append inside their group's branch. **Every branch accumulates all of its optional items in one pass** — never `return` on the first flag that matches, per the regression documented at `customize/rail.ts:110`.

| Group | Static | Flag-gated |
| --- | --- | --- |
| You | profile, preferences, connected | — |
| Workspace | general, members, secrets, channels, repositories, schedules, webhooks | computers (`tunnelEnabled`) |
| Agent | models, instructions, sandbox, snapshots | marketplace, review, voice |
| Organization | billing, usage, groups, roles, identity, audit | — |
| Developer | api-keys, experimental | — |

Static count = 3 + 7 + 4 + 6 + 2 = 22, plus 4 flag-gated = 26. `models` is always present; `llmGatewayAvailable` controls only whether its `llm-*` sub-sections render, not the row.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/features/workspace/settings/rail.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit** (ask first)

---

### Task 5: Build the settings panel on `Tabs` — alongside, deleting nothing

**Rescoped 2026-08-09 after measurement.** This task originally also renamed the
store and deleted `customize-panel.tsx`. A grep found **33 files** importing the
legacy vocabulary, so doing that here leaves no reviewable intermediate and no
working checkpoint. The cutover and every deletion moved to Task 5b.

**Files:**
- Create: `apps/web/src/features/workspace/settings/settings-panel.tsx`
- Create: `apps/web/src/features/workspace/settings/settings-panel.test.tsx`
- Create: `apps/web/src/stores/settings-panel-store.ts` — **new file, alongside**
- Create: `apps/web/src/stores/settings-panel-store.test.ts`
- **Delete nothing. Modify nothing outside these four files.**

> `customize-panel.tsx`, `customize/rail.ts`, `customize/type.tsx`,
> `lib/customize-sections.ts`, and `stores/customize-store.ts` all stay live and
> untouched. The legacy panel remains the mounted one; the new panel is mounted
> nowhere yet. Task 5b flips the mount and deletes the old files.
>
> Gate: `npx tsc --noEmit 2>&1 | grep -c "error TS"` must still return **17**.

**Interfaces:**
- Consumes: `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` with
  `orientation="vertical"` (Task 1), `railGroups` + `isRailItemActive` +
  `UPGRADE_ITEM` (Task 4), `SettingsTab` + `DEFAULT_SETTINGS_TAB` (Task 3),
  `SettingsSectionHeader` (Task 2).
- `isRailItemActive(item: RailItem, tab: SettingsTab | LegacyLlmSubTab): boolean`
  — note the second parameter's real type; `task-4-report.md`'s summary section
  is stale on this.
- Produces: `SettingsPanel({ projectId }: { projectId?: string })` and
  `useSettingsPanelStore` with `{ open, tab, openSettings, setTab, close }`.

**Modelling fact established in Task 4 — do not re-derive it.** The six `llm-*`
ids are legacy URL spellings only. `legacySectionRedirect` folds them to `models`
and returns a full URL; the sub-id is discarded and never becomes panel state,
and `parseSettingsTab` can never yield one. So the Models tab's internal
sub-navigation is **separate local state inside that tab**, not a rail tab.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { SettingsPanel } from './settings-panel';

describe('SettingsPanel', () => {
  test('renders one tablist holding every visible tab', () => {
    const { getAllByRole, getByRole } = render(<SettingsPanel projectId="p1" />);
    expect(getByRole('tablist')).toBeTruthy();
    expect(getAllByRole('tab').length).toBeGreaterThan(20);
  });

  test('exactly one pane is mounted at a time', () => {
    const { getAllByRole } = render(<SettingsPanel projectId="p1" />);
    expect(getAllByRole('tabpanel')).toHaveLength(1);
  });

  test('the active trigger and the mounted pane are wired together', () => {
    const { getByRole, getAllByRole } = render(<SettingsPanel projectId="p1" />);
    const active = getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(active.getAttribute('aria-controls')).toBe(getByRole('tabpanel').id);
  });

  test('renders with no project id', () => {
    const { getByRole } = render(<SettingsPanel />);
    expect(getByRole('tablist')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/workspace/settings/settings-panel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shell**

Port `customize-panel.tsx` wholesale, changing only the navigation mechanism. **Keep verbatim:**
- the `Modal` props: `animation="none"`, `showCloseButton={false}`, `closeOnOutsideClick={false}`, `variant="base"`, and the full `inset-0 … lg:rounded-none` className string
- the `onEscapeKeyDown` guard calling `hasOpenFloatingLayer()` / `hasOpenNestedDialog()`
- the `.kx-titlebar-spacer` div
- the `useProjectCans` probe, `capsResolved`, `isSectionAllowed`, and both fallback `useEffect`s — including the comment explaining that visibility fails open

**Change:** wrap the two-column grid in `<Tabs orientation="vertical" value={tab} onValueChange={setTab}>`. The sidebar `<section>` holds `<TabsList orientation="vertical">` with one `<TabsTrigger>` per item; `<main>` holds one `<TabsContent>` per tab.

Group labels stay `<Label className="text-muted-foreground px-2 pb-1">`. `TabsList` cannot contain non-trigger children in Radix, so render **one `TabsList` per group** rather than one for the whole rail, each preceded by its label. Confirm arrow-key roving still moves within a group; if crossing groups matters, note it as a follow-up rather than flattening the labels away.

Keep the Review badge and the Upgrades attention dot on their triggers.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/features/workspace/settings/settings-panel.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Create the new store as a NEW file**

Create `stores/settings-panel-store.ts` beside the existing one. Do **not** rename,
edit, or shim `stores/customize-store.ts` — it stays live for the legacy panel
until Task 5b. A third failed shim attempt is not wanted; see the ledger's Task 3
entry for why aliasing two vocabularies cannot work.

Shape, mirroring the legacy store so Task 5b's cutover is mechanical:

```ts
interface SettingsPanelState {
  open: boolean;
  tab: SettingsTab;
  openSettings: (tab?: SettingsTab, opts?: { membersTab?: string }) => void;
  setTab: (tab: SettingsTab) => void;
  close: () => void;
}
```

`openSettings(undefined)` must reopen on the last-viewed tab — that is the
existing behaviour and the reason `resolveSettingsOverlayHref` returns
`opensOverlay: false` for unresolvable segments rather than `undefined`. Read
`stores/customize-store.ts` first and carry across any behaviour it has that this
shape omits (the `membersTab` option exists because the command palette deep-links
into the members invite flow).

- [ ] **Step 6: Verify the panel renders — no browser needed**

The panel is mounted nowhere yet, so there is nothing to click. Assert what SSR
can show: the tablist exists, every expected trigger renders, exactly one pane is
mounted, and the active trigger's `aria-controls` matches the pane's id.

Interaction (↑/↓ roving, Tab exiting the list, theme switching) **cannot** be
tested here and must not be faked. Note in the report that it is deferred to the
Playwright harness, and it gets exercised for real in Task 5b once the panel is
actually mounted.

- [ ] **Step 7: Commit** (ask first)

---

### Task 6: Routes and redirects

**Rescoped 2026-08-09, before dispatch.** This task originally also redirected the
legacy `/customize/*` routes and stripped every `/customize/` href from the menu
registry. Both are unsafe until Task 5b: the new panel's panes are still
placeholders and the legacy panel is still the mounted one, so redirecting would
send a user clicking Secrets from working content to an empty stub — a live
regression shipped by an additive task. The redirect and the registry repoint move
to Task 5b, after the five legacy-store views are converted and the mount flips.

**Files:**
- Create: `apps/web/src/app/(app)/projects/[id]/settings/page.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/settings/[tab]/page.tsx`
- Create: `apps/web/src/app/(app)/settings/[tab]/page.tsx`
- Test: `apps/web/src/features/workspace/settings/route-contract.test.ts`
- **Leave both `customize` route files untouched. Leave `menu-registry.ts` untouched.**

> Nothing links to `/settings/*` yet, which is intentional — the routes are
> reachable by URL and by nothing else until Task 5b repoints the registry. Both
> route families work simultaneously in the meantime.
>
> Gate: `npx tsc --noEmit 2>&1 | grep -c "error TS"` must still return **17**.

**Interfaces:**
- Consumes: `legacySectionRedirect`, `parseSettingsTab` (Task 3).
- Produces: the three route entry points above.

- [ ] **Step 1: Read the Next docs**

Per `apps/web/AGENTS.md`, this version of Next has breaking changes versus training data. Read `node_modules/next/dist/docs/` on redirects and dynamic route params **before** writing any route file.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { SETTINGS_TABS, parseSettingsTab } from './settings-tabs';

describe('settings route segments', () => {
  test('every tab id is a usable URL segment', () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab).toMatch(/^[a-z0-9-]+$/);
      expect(parseSettingsTab(tab)).toBe(tab);
    }
  });

  test('an unknown segment does not resolve to a tab', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab('Members')).toBeNull();
  });
});
```

The menu-registry assertion that used to live here moved to Task 5b along with the
repoint itself — asserting zero `/customize/` hrefs while the registry is
deliberately still pointing at them would be a test that must fail.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/workspace/settings/route-contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Add the three routes**

`/projects/[id]/settings/[tab]` parses the segment with `parseSettingsTab` and opens
the panel on it; an unparseable segment redirects to `/projects/[id]/settings`.
`/projects/[id]/settings` opens on `DEFAULT_SETTINGS_TAB`. `/settings/[tab]` does
the same with no project context.

Touch neither `customize` route file and not `menu-registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun test src/features/workspace/settings/route-contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm both route families still resolve**

Run `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly **17**, and
`bun test src/` against the 4959 baseline.

With the stack running, confirm `/projects/<id>/customize/secrets` still serves the
LEGACY panel with real content, and `/projects/<id>/settings/secrets` serves the new
panel with its placeholder. Both working simultaneously is the point of this step.

- [ ] **Step 7: Commit** (ask first)

---

# Phase 2 — The You group

### Task 7: Profile tab

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/profile-tab.tsx`
- Test: `apps/web/src/features/workspace/settings/tabs/profile-tab.test.tsx`
- Modify: `apps/web/src/features/workspace/settings/settings-panel.tsx` — replace the
  `profile` placeholder with the real tab

**Interfaces:**
- Consumes: `SettingsSectionHeader` (Task 2).
- Produces: `ProfileTab(): JSX.Element`, and a pure `ProfileTabView` if the container
  needs providers to render (see the test note below).

Sections in order, each a `SettingsSectionHeader` plus its control:

1. Profile picture — avatar with upload and remove
2. Name — display name, inline save
3. Email — read-only
4. Two-factor authentication — the MFA factor list from `security-tab.tsx`
5. Delete account — destructive

**Sources to port from, not reinvent:**
`features/accounts/settings/general-tab.tsx` (name, avatar) and
`features/accounts/settings/security-tab.tsx` (MFA factors — TOTP and phone). Read both
in full first.

**Do not invent a password-change control.** `security-tab.tsx` holds MFA enrollment only.
No password surface exists in this codebase; building one is new work, out of scope, and
should be raised separately rather than improvised here.

**Log out is not on this tab.** It stays in `user-menu.tsx`, which this whole effort
leaves untouched by the user's explicit instruction.

**The panel mounts every pane.** `SettingsTabPane` already gates with
`if (!active) return null`, so a tab only renders when selected — but do not add
module-level side effects or top-level fetches that would defeat that.

- [ ] **Step 1: Write the failing test**

There is no DOM in `bun test`. Use `renderToStaticMarkup` and assert on the HTML string,
matching `components/ui/settings-section-header.test.tsx`.

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileTabView } from './profile-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders every section heading in order', () => {
    expect(headings(html())).toEqual([
      'Profile picture',
      'Name',
      'Email',
      'Two-factor authentication',
      'Delete account',
    ]);
  });

  test('the delete action is destructive', () => {
    expect(html()).toContain('destructive');
  });

  test('email is read-only', () => {
    expect(html()).toMatch(/<input[^>]*readonly/i);
  });

  test('renders no password-change control', () => {
    expect(html().toLowerCase()).not.toContain('password');
  });
});
```

If the `<h2>` regex returns nothing, print the real SSR output and fix the matcher against
what `SettingsSectionHeader` actually emits — do not weaken the assertion to make it pass.

- [ ] **Step 2: Run to verify it fails.** `cd apps/web && bun test src/features/workspace/settings/tabs/profile-tab.test.tsx`

- [ ] **Step 3: Implement.** If the container needs React Query, the router, or Supabase to
render, split a pure `ProfileTabView` that takes its data as props and test that — the
codebase already does this (`MigrateToV2ButtonView`, `SettingsPanelShell`). Do NOT reach
for a DOM library; none is installed and adding one is a repo-wide decision.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Wire it into the panel**, replacing the `profile` placeholder.

- [ ] **Step 6: Run the gates.** `npx tsc --noEmit 2>&1 | grep -c "error TS"` → **17**;
`bun test src/` → no net loss; `npx eslint` on touched files → clean.

- [ ] **Step 7: Commit**

---

### Task 8: Preferences tab

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/preferences-tab.tsx`
- Test: `apps/web/src/features/workspace/settings/tabs/preferences-tab.test.tsx`
- Modify: `apps/web/src/features/workspace/settings/settings-panel.tsx` — replace the
  `preferences` placeholder

**Interfaces:**
- Consumes: `SettingsSectionHeader` (Task 2), `THEME_OPTIONS` from `features/layout/user-menu`.
- Produces: `PreferencesTab()`, plus a pure `PreferencesTabView` if the container needs
  providers (follow `ProfileTabView` from Task 7).

Appearance leads, because the user specified a full light/dark system as the centrepiece.

1. **Theme** — Light / Dark / System
2. **Wallpaper** — the existing wallpaper set
3. **Sounds** — sound packs and preview
4. **Notifications** — browser notifications and delivery
5. **Keyboard shortcuts** — reference list
6. **Language**

**Sources to port from, not reinvent:** `features/accounts/settings/appearance-tab.tsx`,
`sounds-tab.tsx`, `notifications-tab.tsx`, `keyboard-shortcuts-tab.tsx`, and
`language-switcher.tsx`. Read each before designing.

**Import `THEME_OPTIONS` from `user-menu.tsx` rather than re-declaring the three values.**
The spec requires these two surfaces cannot drift; a shared import makes drift impossible
rather than merely discouraged. Do not otherwise modify `user-menu.tsx` — this effort
leaves it untouched by the user's explicit instruction.

**Notifications appears here and nowhere else.** The user's original list had it under two
groups; only the user-scoped one exists.

- [ ] **Step 1: Write the failing test**

No DOM in `bun test`. Use `renderToStaticMarkup`, matching Task 7's `profile-tab.test.tsx`.

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { PreferencesTabView } from './preferences-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

const html = () => renderToStaticMarkup(<PreferencesTabView />);

describe('PreferencesTabView', () => {
  test('appearance leads', () => {
    expect(headings(html())[0]).toBe('Theme');
  });

  test('renders every preference section in order', () => {
    expect(headings(html())).toEqual([
      'Theme', 'Wallpaper', 'Sounds', 'Notifications', 'Keyboard shortcuts', 'Language',
    ]);
  });

  test('offers exactly the themes the user menu offers, in the same order', () => {
    const out = html();
    for (const { label } of THEME_OPTIONS) expect(out).toContain(label);
    const positions = THEME_OPTIONS.map((o) => out.indexOf(o.label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**, splitting a pure view if the container needs providers.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Wire it into the panel**, replacing the `preferences` placeholder.
- [ ] **Step 6: Run the gates.** `npx tsc --noEmit 2>&1 | grep -c "error TS"` → **17**;
`bun test src/` → no net loss; `npx eslint` on touched files → clean.
- [ ] **Step 7: Commit**

---

### Task 9: Connected accounts tab

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/connected-tab.tsx`
- Test: `apps/web/src/features/workspace/settings/tabs/connected-tab.test.tsx`
- Modify: `apps/web/src/features/workspace/settings/settings-panel.tsx` — replace the
  `connected` placeholder

**Interfaces:**
- Consumes: `SettingsSectionHeader` (Task 2).
- Produces: `ConnectedAccountsTab({ projectId?, accountId? })` plus a pure
  `ConnectedAccountsTabView`, following `ProfileTabView` / `PreferencesTabView`.

**Scope conflict — asked three times, no answer, proceeding with the specified option.**

None of the three providers is user-scoped, so a tab named "Connected accounts" in a group
named "You" holds nothing belonging to the signed-in person:

- **GitHub is account-scoped.** `listGitHubInstallations(accountId)` /
  `deleteGitHubInstallation(accountId, installationId)`; writing needs `account.write`.
- **ChatGPT is project-scoped.** `startProjectProviderOAuth(projectId, 'openai')`, then
  invalidates `qk.project.secrets(projectId)`.
- **Claude Code** follows the same project-scoped provider-OAuth pattern.

Building it as specified (under You). **Each row must state its scope in its description** —
"for the Acme account", "for this workspace" — so a user disconnecting GitHub is not led to
believe they are unlinking their own login when they are removing the installation the
whole account's repos depend on.

**Three rows, one button each. No modal, no accordion, no search on this tab.**

| Provider | Connected | Disconnected |
| --- | --- | --- |
| GitHub | installation name + `Disconnect` | `Connect` |
| ChatGPT | plan name + `Disconnect` | `Connect` |
| Claude Code | plan name + `Disconnect` | `Connect` |

The GitHub row hides entirely without `account.write`.

**Reuse, do not reinvent:** `GitHubConnectionCard` in the deleted account page's history and
`ChatGptSubscriptionConnect` at
`features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect.tsx`.
Read both before designing. Prefer exporting and importing over copying — a prior task was
corrected for copying a component it could have exported.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectedAccountsTabView } from './connected-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('ConnectedAccountsTabView', () => {
  test('renders one row per provider, in order', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(headings(out)).toEqual(['GitHub', 'ChatGPT', 'Claude Code']);
  });

  test('every row states which scope it writes to', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(out).toMatch(/for this account/i);
    expect(out).toMatch(/for this workspace/i);
  });

  test('the GitHub row is absent without account.write', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount={false} />);
    expect(headings(out)).toEqual(['ChatGPT', 'Claude Code']);
  });

  test('each row carries exactly one action button', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect([...out.matchAll(/<button/g)]).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**, splitting a pure view.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Wire it into the panel**, replacing the `connected` placeholder. Note
`settings-panel.test.tsx` currently uses `connected` as its still-a-placeholder example —
move that to a tab that genuinely is one, and verify the replacement.
- [ ] **Step 6: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 7: Commit**

---

### Task 10: Retire `SidePanelUserSettings`

**Files:**
- Modify: `apps/web/src/features/layout/user-menu.tsx` — **call target only**
- Create: `apps/web/src/hooks/account/use-mfa.ts` — extracted MFA state machine
- Modify: `apps/web/src/features/workspace/settings/tabs/profile-tab.tsx` — consume it
- Delete: `apps/web/src/features/accounts/settings/side-panel-user-settings.tsx`
- Delete: `apps/web/src/features/accounts/settings/security-tab.tsx` and its test, **only
  once their exports have a home**
- Test: `apps/web/src/features/layout/user-menu.test.tsx`

**Hard constraint:** `user-menu.tsx` is **not** restructured. The product owner has a
separate plan for it. Change nothing but the call target — not the dropdown structure, not
the account row, not Home / Download, not the theme submenu, not Help or legal, not the
logout dialog.

**Extract the MFA state machine; do not just delete one copy.**

Task 7 built Profile by porting MFA from `security-tab.tsx`. `FactorRow` and `totpQrSrc`
are genuinely shared (imported), but ~90 lines of orchestration are duplicated:
`factorsQuery`, `aalQuery`, the enroll / verify / remove mutations, and cancel-enroll
cleanup. Both read and write the same query keys (`['mfa-factors']`, `['mfa-aal']`), so
they share one cache today and cannot disagree at runtime.

Deleting `side-panel-user-settings.tsx` removes the *second consumer* of `security-tab.tsx`
but leaves Profile's copy as the sole survivor — unreviewed against whatever
`security-tab.tsx` had accumulated. So: extract into `hooks/account/use-mfa.ts`, have
Profile consume it, then `security-tab.tsx` can go with its consumer.

Before deleting `security-tab.tsx`, note `profile-tab.tsx` imports `FactorRow` and
`totpQrSrc` from it, and `security-tab.test.tsx` imports both. Those exports need a home —
move them, do not orphan them.

**Also carries** the `appearance-tab.tsx` and `notifications-tab.tsx` question: both were
given exports (`WallpaperCard`, `NotificationToggle`) for the new tabs to import, and both
still back `SidePanelUserSettings`. Once it is deleted, decide whether each file survives
as a home for shared primitives or whether those primitives move — and say which.

- [ ] **Step 1: Extend the existing user-menu test**

No DOM in `bun test`, so this asserts store state after calling the handler, not a click.

```tsx
import { describe, expect, test } from 'bun:test';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

describe('user menu settings entry points', () => {
  test('the user settings row opens the panel on profile', () => {
    useSettingsPanelStore.getState().openSettings('profile');
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('profile');
  });

  test('the billing row opens the panel on billing', () => {
    useSettingsPanelStore.getState().openSettings('billing');
    expect(useSettingsPanelStore.getState().tab).toBe('billing');
  });
});
```

If `user-menu.tsx` exposes its handlers in a testable form, assert through those instead —
that is strictly better than asserting the store directly. Say which you did.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Extract `use-mfa.ts`** and have Profile consume it. Prove behaviour is
unchanged before deleting anything.
- [ ] **Step 4: Repoint `user-menu.tsx`'s call target**, nothing else.
- [ ] **Step 5: Delete `side-panel-user-settings.tsx`**, then `security-tab.tsx` once its
exports have moved.
- [ ] **Step 6: Confirm nothing is orphaned.**
`grep -rn "side-panel-user-settings\|SidePanelUserSettings" apps/web/src` → nothing.
- [ ] **Step 7: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

# Phase 3 — The Organization group, and deleting `/accounts/**`

### Task 11: Shared account resolution, then the Billing tab

**Phase 3 adds six account-scoped tabs** — Billing, Usage, Groups, Roles, Identity, Audit,
plus API keys. Every one needs the same answer to "which account am I configuring?", and
JAY-497 already solved it *locally*:

```ts
// connected-tab.tsx:160 — a local export
export function resolveConnectedAccountsId(
  projectAccountId: string | undefined,
  selectedAccountId: string | null | undefined,
): string | undefined {
  return projectAccountId ?? selectedAccountId ?? undefined;
}
```

Lift it before it is copied six times. That is step 1 of this task.

**Why the fallback matters, so nobody simplifies it away:** these tabs are account-scoped
and several gate on `usePermission('…')`, which needs an account id. Sourcing it only from
`project?.account_id` means opening the panel with **no project** leaves the permission
unresolvable — and the gated control silently disappears for a user who genuinely holds the
permission. No error, no explanation. `useCurrentAccountStore`'s `selectedAccountId` is the
app-wide active account, set by the account and project switchers and persisted, so it is
available with no project open.

Two alternatives were considered and rejected in JAY-497, recorded here so they are not
re-litigated: `useAuth()` exposes only a Supabase `user`/`session` and has no account
concept; `useBillingAccountId()` is fed the identical `project?.account_id` by its only
provider, so it is not independent.

**Files:**
- Create: `apps/web/src/features/workspace/settings/use-settings-account-id.ts` — the
  shared hook plus the pure resolver
- Test: alongside
- Modify: `apps/web/src/features/workspace/settings/tabs/connected-tab.tsx` — consume the
  shared hook, drop the local copy
- Create: `apps/web/src/features/workspace/settings/tabs/billing-tab.tsx`
- Test: alongside
- Modify: `settings-panel.tsx` — replace the `billing` placeholder

**Interfaces:**
- Produces `useSettingsAccountId(projectAccountId?: string): string | undefined` and the
  pure `resolveSettingsAccountId(projectAccountId, selectedAccountId)`.
- Produces `BillingTab({ accountId }: { accountId?: string })` and a pure `BillingTabView`.

**Do not regress JAY-497.** Its `connected-tab.test.tsx` covers the resolver's three cases.
Port them onto the shared function rather than deleting them, and keep the tab's behaviour
identical.

- [ ] **Step 1: Extract the shared hook.** Move the resolver, port JAY-497's three resolver
tests, make `connected-tab.tsx` consume it, and confirm its own tests still pass. Land this
before touching Billing — it is independently verifiable.

- [ ] **Step 2: Enumerate the source behaviour before moving it.** Read
`features/accounts/settings/billing-tab.tsx` end to end and write a numbered list of every
control, query, and mutation into the report. The account page it came from is 2378 lines;
moving it blind drops behaviour, and a dropped billing control is not something an unwritten
test will catch.

- [ ] **Step 3: Write the failing test.** No DOM in `bun test` — use `renderToStaticMarkup`
against `BillingTabView`, following `profile-tab.test.tsx`. Assert each enumerated section
renders and that plan, wallet, and spend appear before the rest.

- [ ] **Step 4: Run to verify it fails.**

- [ ] **Step 5: Implement**, wrapping each section in `SettingsSectionHeader`. Gate on
`billing.write` **and** `isBillingEnabled()` — a self-hosted build with billing off must
render nothing here rather than a broken Stripe control.

- [ ] **Step 6: Run to verify it passes.**

- [ ] **Step 7: Wire into the panel**, replacing the `billing` placeholder. Note
`settings-panel.test.tsx` uses `billing` as its still-a-placeholder example — move that to a
tab that genuinely still is one and verify by grep.

- [ ] **Step 8: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.

- [ ] **Step 9: Commit**

---

### Task 12: Usage tab

The credit ledger and the cost explorer answer the same question — "where did the money
go" — so they share one tab, with the chart first because it is the faster answer.

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/usage-tab.tsx`
- Test: alongside
- Modify: `settings-panel.tsx` — replace the `usage` placeholder

**Interfaces:** Consumes `SettingsSectionHeader`, `useSettingsAccountId`. Produces
`UsageTab({ accountId?: string })` and a pure `UsageTabView`.

**Sources:** `features/billing/cost-explorer/cost-explorer.tsx` and
`features/accounts/settings/transactions-tab.tsx`. Read both in full first.

**Gating — apply the lesson from Task 11.** Do not collapse read and write access into one
permission. Task 11 shipped a brief that gated Billing on `billing.write` alone, which is
`OWNER_ONLY`, and that would have hidden read-only content from non-owner admins who had it
before. Check what the old account page actually gated the transactions section on
(`app/(app)/accounts/[id]/page.tsx`'s `sectionVisible` map — still live, read it) and match
it. **Session costs must remain available when `isBillingEnabled()` is false** — the old
page kept them deliberately, because they do not require the internal billing engine.

**Account id:** use `useSettingsAccountId` from
`features/workspace/settings/use-settings-account-id.ts`. Do not source it from
`project?.account_id` alone — that leaves the permission unresolvable with no project open
and silently hides gated content.

**Provenance rule, new as of Task 11.** If you state that something was reused, ported, or
copied from somewhere, cite a quote or a `file:line`. Three reports in this effort have
overclaimed provenance and been corrected on review. Claims about what code *does* have
held up; claims about where it *came from* have not.

- [ ] **Step 1: Enumerate the source behaviour.** Read both source files end to end and
write a numbered list of every control, query, and mutation into the report, with where each
lands in the new tab. That list is the checklist the review will hold you to.

- [ ] **Step 2: Write the failing test.** No DOM in `bun test` — `renderToStaticMarkup`
against `UsageTabView`, following `billing-tab.test.tsx`.

```tsx
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

test('the cost explorer renders above the credit ledger', () => {
  const out = renderToStaticMarkup(<UsageTabView {...props} />);
  const h = headings(out);
  expect(h.indexOf('Spend')).toBeLessThan(h.indexOf('Credit ledger'));
});
```

Use whatever headings the sections actually carry — read them, do not assume "Spend" and
"Credit ledger" are the real strings.

- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.** Cost explorer keeps its drill-down levels (projects → sessions
→ models) and its export button.
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Wire into the panel**, replacing the `usage` placeholder. `settings-panel.test.tsx`
uses `usage` as its still-a-placeholder example — move that to a tab that genuinely is one
and verify by grep.
- [ ] **Step 7: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 13: Groups and Roles tabs

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/groups-tab.tsx`
- Create: `apps/web/src/features/workspace/settings/tabs/roles-tab.tsx`
- Tests: alongside each
- Modify: `settings-panel.tsx` — replace both placeholders

**Interfaces:** Consume `SettingsSectionHeader`, `useSettingsAccountId`. Produce
`GroupsTab`/`GroupsTabView` and `RolesTab`/`RolesTabView`.

**The gating is asymmetric, and none of it follows from the tab names.** Read
`app/(app)/accounts/[id]/page.tsx` — still live — and match it exactly:

```
:356  groups: true                        // visible to EVERYONE, no permission gate
:357  roles:  canManageRoles === true     // requires role.create
:308  rbacEnabled = !!entitlements?.rbac  // gates the PANE CONTENT, not visibility
```

Three distinct gates across two tabs:
- **Groups** is visible to every member. Its *content* is entitlement-gated.
- **Roles** is visible only with `role.create`. Its content is entitlement-gated too.
- A non-entitled account sees `EnterpriseUpsell` **in place of the pane, with the tab still
  visible** — that is deliberate discoverability, mirroring the server's `402` from
  `requireEntitlement`, so an admin never touches a control the backend rejects.

**While entitlements are still loading, render neither the pane nor the upsell.** Flashing
the upsell at an enterprise account is a bug the old page specifically avoided — check how
it does that before writing your own version.

This asymmetry is exactly what an earlier task got wrong by inferring a permission from a
tab's name, which hid read-only content from users who had it. Read the map.

**The group detail page is 1117 lines and needs a real answer.**
`app/(app)/accounts/[id]/groups/[groupId]/page.tsx` is a full detail surface. It cannot be
folded into a tab pane, and it must not be silently dropped — a later task deletes
`/accounts/**`, so "it still works today" is not a plan.

Decide and report: recreate it at `/settings/groups/[groupId]`, or keep it as a standalone
route the tab links to. Say which and why. Do **not** move or delete it in this task — just
make the tab reach it correctly and state the destination so the deletion task can honour
it.

**Account id:** `useSettingsAccountId`. Never `project?.account_id` alone.

**Provenance:** assert reuse only with a quote or `file:line`.

- [ ] **Step 1: Enumerate.** Read `components/iam/groups-tab.tsx` and `roles-tab.tsx` end to
end, plus the old page's rendering of each, and list every control, query, and mutation with
where it lands.
- [ ] **Step 2: Write the failing tests.** `renderToStaticMarkup` against the pure views.
Pin all three gates: entitled renders the pane; non-entitled renders the upsell with the tab
still present; loading renders neither.
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Wire both into the panel.** `settings-panel.test.tsx` uses one tab as its
still-a-placeholder example — move it to a tab that genuinely is one and verify by grep.
- [ ] **Step 7: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 13b: Filter account-scoped tabs out of the rail

**Added during execution.** Discovered while reviewing Task 13, and it spans tasks rather
than belonging to any one of them — which is why the per-task reviews could not see it.

**The problem.** The rail's probe (`CUSTOMIZE_SECTION_GATE_ACTIONS`, `lib/project-actions.ts`)
carries only **project** actions. Account-scoped tabs are never filtered by it, so
`isTabAllowed` falls through to "allowed" for all of them. Each tab then enforces its own
permission by returning `null` from its container — producing a **rail row that renders
nothing when clicked.** No message, no explanation.

The surface this replaced did not behave that way: `app/(app)/accounts/[id]/page.tsx:354-365`
builds a `sectionVisible` map and filters the nav row itself.

**Already shipped with this shape:** Billing (`account.write`, `billing-tab.tsx:450`),
Usage (`account.write`), Roles (`role.create`). **About to inherit it:** Identity, Audit,
API keys. Fixing it once across three consumers beats seven.

It is a *documented* choice — `settings-panel.tsx:158-170` names every affected tab — so this
is revisiting a design decision, not correcting an oversight.

**Files:**
- Modify: `apps/web/src/features/workspace/settings/settings-panel.tsx`
- Modify: `apps/web/src/features/workspace/settings/rail.ts` if the gate list belongs there
- Tests alongside

**The change.** Give the rail account-scoped gating beside its project probe, so a denied
tab is **absent** rather than present and empty. The per-tab `return null` stays as a
backstop.

**Mirror the existing model, do not invent one.** The project probe fails **open** — loading
and errored both render the full rail, because visibility is not a security boundary and the
API re-checks every mutation. Account gating must fail open the same way, or a slow probe
blanks the rail.

**A decision to make deliberately, not by default.** `usePermission` returns `false` while
loading **and on error** (`use-permission.ts:26-27`, a documented fail-closed default). Once
rows are hidden on denial, a *failed probe* becomes indistinguishable from a denial — the
user cannot tell "no access" from "could not determine access." This is the third time in
this effort a fail-closed default has produced a silently-missing control. Decide whether a
failed probe hides the row or keeps it visible with an error inside, and say which and why.

**Do not turn entitlement gating into hidden rows.** Groups and Roles must keep showing
`EnterpriseUpsell` in place of the pane **with the tab still visible** — that is deliberate
discoverability mirroring the server's `402`.

- [ ] **Step 1: Write the failing tests.** Per gated tab, pin three states: permitted renders
the row, denied hides it, unresolved renders it (fail open).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Update `settings-panel.tsx:158-170`'s comment** — it currently documents the
old choice as intentional.
- [ ] **Step 6: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 7: Commit**

---

### Task 14: Identity tab

**The verification that gated this task is DONE.** `/accounts/[id]/sso-setup` and
`/scim-setup` are wizard UI pages, not IdP callback targets — SAML's ACS belongs to
Supabase (`sso-provisioning.ts:81,140` registers via `/auth/v1/admin/sso/providers`) and
SCIM's base URL is `/scim/v2/accounts/{accountId}` on the API (`scim-tokens.ts:124`). Every
route reference is an internal `<Link>`. JAY-505 is unblocked. **Do not re-run that
verification** — build the tab.

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/identity-tab.tsx`
- Test: alongside
- Modify: `settings-panel.tsx` — replace the `identity` placeholder

**Interfaces:** Consumes `SettingsSectionHeader`, `useSettingsAccountId`. Produces
`IdentityTab({ accountId? })` and a pure `IdentityTabView`.

**Sources:** `components/iam/sso-card.tsx`, `components/iam/scim-card.tsx`,
`components/iam/identity-intro.tsx`. Read all three first. Prefer mounting them as slots
over reimplementing — the pattern `usage-tab.tsx` used.

**Gating — read the map, do not infer from the tab name.** From
`app/(app)/accounts/[id]/page.tsx` (still live):

```
:361  identity: canWriteAccount === true
:300  enterpriseIdentityEnabled = !!(entitlements?.sso || entitlements?.scim)
```

So: **`account.write`** for the tab, and the **`sso` OR `scim`** entitlement for the pane —
note it is an OR, not `rbac`, and not both. A non-entitled account sees `EnterpriseUpsell`
with the tab still visible. While entitlements load, render neither.

**Rail gating is already handled.** Task 13b added `ACCOUNT_TAB_PERMISSION` to
`settings-panel.tsx`; add `identity: 'account.write'` there so the row hides for users who
cannot open it, rather than rendering a dead row. Keep the container's own guard as a
backstop.

**The wizard links.** `sso-card.tsx:247` and `scim-card.tsx:268,386` link to
`/accounts/[id]/sso-setup` and `/scim-setup`, which are still live. Leave those links alone
— JAY-505 owns moving them. Do not repoint them at routes that do not exist yet.

**Account id:** `useSettingsAccountId`. **Provenance:** quote or `file:line` only.

- [ ] **Step 1: Enumerate** all three source components — every control, query, mutation.
- [ ] **Step 2: Write the failing test.** `renderToStaticMarkup` against `IdentityTabView`.
Pin three states: entitled renders the cards, non-entitled renders the upsell with the tab
present, loading renders neither.
- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Wire into the panel** and add the rail gate entry. Move
`settings-panel.test.tsx`'s placeholder example if it currently uses `identity`.
- [ ] **Step 7: Run the gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 15: Audit log tab

**Files:**
- Create: `apps/web/src/features/workspace/settings/tabs/audit-tab.tsx`
- Test: alongside
- Modify: `settings-panel.tsx` — replace the `audit` placeholder, add the rail gate entry

**Interfaces:** Consumes `SettingsSectionHeader`, `useSettingsAccountId`. Produces
`AuditTab({ accountId? })` and a pure `AuditTabView`.

**Source:** `components/iam/audit-tab.tsx`. Mount it as a slot; do not reimplement — it
still backs the live `/accounts` page.

**Gating, read off the live map** (`app/(app)/accounts/[id]/page.tsx`):

```
:363  audit: canReadAudit === true      // NOT account.write
:309  auditEnabled = !!entitlements?.auditAccess   // NOT rbac, NOT sso/scim
```

Both differ from every other tab in this group — `audit.read` rather than `account.write`,
and `auditAccess` rather than `rbac` or `sso||scim`. Verify both against the source; do not
carry an expression over from a neighbouring tab.

Three states as elsewhere: entitled renders the log; non-entitled renders `EnterpriseUpsell`
with the tab still visible; loading renders neither.

**Rail:** add `audit: 'audit.read'` to `ACCOUNT_TAB_PERMISSION`. That auto-extends the
permitted/denied/loading/errored loop tests — no new rail test needed.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` before writing UI.
Specifically: no hand-rolled chips — use `Badge`; `rounded-md` panels and `rounded-sm`
status tiles; in-flow panels flat with a border, no shadow; `tabular-nums` on any
timestamp or count that updates; `Loading` for pending, never an icon.

**Account id:** `useSettingsAccountId`. **Provenance:** quote or `file:line` only.

- [ ] **Step 1: Enumerate** the source's controls, queries, and filters.
- [ ] **Step 2: Failing test** — `renderToStaticMarkup` against `AuditTabView`, pinning the
three entitlement states.
- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Wire into the panel** + rail gate. Move the placeholder example if it uses
`audit`.
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 16: API keys tab

**Files:** Create `apps/web/src/features/workspace/settings/tabs/api-keys-tab.tsx`; test alongside.
Modify `settings-panel.tsx` (replace the placeholder, add the rail gate).

**Interfaces:** Produces `ApiKeysTab({ accountId }: { accountId?: string })` and a pure
`ApiKeysTabView`.

**Gate, read off the live map** (`app/(app)/accounts/[id]/page.tsx:362`):
`tokens: canWriteAccount === true` — i.e. `account.write`, admin+owner. Not owner-only, and
not a separate `token.*` permission. Add `'api-keys': 'account.write'` to
`ACCOUNT_TAB_PERMISSION`.

**Source — mount, do not reimplement.** The live pane (`page.tsx:589-594`) is two cards in a
`space-y-10` wrapper, both gated on the same `canWriteAccount`:

```
:591  <PatPolicyCard accountId={…} canManage={canWriteAccount} />
:592  <ServiceAccountsCard accountId={…} canManage={canWriteAccount} />
```

Mount both as slots. `/accounts/**` is deleted in a later task and neither card is mounted
anywhere else — verify that claim yourself with a repo-wide grep and report the result, since
dropping one would remove a shipped feature with no build error.

**Scope correction — read before building the table.** The task originally specified a new
table with columns `name, prefix, scope, created, last used`, merging user CLI tokens and
account tokens. Investigation found no data source for most of it:

- `ServiceAccountsCard` **already renders a table** — `service-accounts-card.tsx:131-145`,
  columns `Name / Status / Last used / actions`.
- The only other key surfaces in `apps/web` are `gateway-keys.tsx` (LLM provider keys, a
  different group) and `api-key-connect-form.tsx` (provider connect). Neither is a developer
  API key list.
- No separate user-CLI-token list component was found.

So: **do not build a second table, and do not invent columns.** The existing table is the
source of truth for which fields exist. Your job is to report, in the report file, exactly
which of the five requested columns have a backing field on the service-account record and
which do not. A column with no field is a gap to name, never a value to fabricate or leave
blank.

**Add the usage snippet.** The one genuinely new element: a copyable code block showing how
to authenticate with a token. Use the existing `CopyButton`
(`apps/web/src/components/markdown/copy-button.tsx`) — do not hand-roll a copy control.

**Pagination: filter-only.** The question of whether the list paginates was raised with the
user and is still unanswered. Implement client-side filtering only, add no pagination
control, and state this plainly in the report as an open decision rather than a finished one.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first. Specifically:
`Badge` for status chips, never a hand-rolled span; `rounded-md` panels; `tabular-nums` on
the "Last used" column so timestamps do not shift; `Loading` for pending, never an icon;
`ConfirmDialog` before any revoke (the cards already do this — do not weaken it).

**Account id:** `useSettingsAccountId`. **Provenance:** quote or `file:line` only.

- [ ] **Step 1: Enumerate** what each card renders and which fields the records carry.
- [ ] **Step 2: Failing test** — `renderToStaticMarkup` against `ApiKeysTabView`, pinning the
header, both card slots, and the snippet's presence.
- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Wire into the panel** + rail gate.
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 17: Recreate the account routes under `/settings/`, repoint every linker, delete `/accounts/**`

**This is the highest-risk task in the effort.** It deletes nine live files. Read the whole
task before touching anything, and do the inventory step first.

**Unblocked as of 2026-08-10** — its four blockers (JAY-545, JAY-506, JAY-507, JAY-546) are
all closed, so every pane of `accounts/[id]/page.tsx` now has a home in the panel.

**What is actually being deleted — nine files, not one page:**

```
apps/web/src/app/(app)/accounts/layout.tsx
apps/web/src/app/(app)/accounts/loading.tsx
apps/web/src/app/(app)/accounts/page.tsx                        ← account list
apps/web/src/app/(app)/accounts/[id]/page.tsx                   ← the tabbed page, all panes rehomed
apps/web/src/app/(app)/accounts/[id]/sso-setup/page.tsx         ← wizard, MUST be recreated
apps/web/src/app/(app)/accounts/[id]/scim-setup/page.tsx        ← wizard, MUST be recreated
apps/web/src/app/(app)/accounts/[id]/groups/[groupId]/page.tsx  ← detail, MUST be recreated
apps/web/src/app/(app)/accounts/[id]/members/[userId]/page.tsx  ← detail, MUST be recreated
apps/web/src/app/(app)/accounts/[id]/tokens/[tokenId]/page.tsx  ← detail, MUST be recreated
```

Only `[id]/page.tsx`, `layout.tsx`, `loading.tsx`, and the list `page.tsx` are pure
deletions. The other five are **route moves** — each has live callers that push to it.

**Hard condition 1 — the wizards are UI, not IdP callbacks.** Verified: SAML ACS belongs to
Supabase (`sso-provisioning.ts:81,140`); the SCIM base URL is
`/scim/v2/accounts/{accountId}` (`scim-tokens.ts:124`). So no external identity provider
posts to `/accounts/{id}/sso-setup` or `/scim-setup`, and moving them is safe. Recreate both
under `/settings/`, and repoint their pushers: `components/iam/sso-card.tsx:247` and
`components/iam/scim-card.tsx:268,386`.

**Hard condition 2 — do NOT touch `apps/web/public/sso-setup/`.** It is an **asset
directory** (`auth0/`, `cloudflare/`, `entra/` screenshot folders), referenced **70 times**
by `features/sso-setup/guides.ts`. Its name matches the route being moved. A
name-matching deletion breaks every screenshot in the SSO guides with **no build error**.
Verify with `grep -c "sso-setup" apps/web/src/features/sso-setup/guides.ts` before and after;
the count must stay 70.

**The nine live linkers to repoint** (re-enumerate and confirm — do not trust this list
blind):

| # | File:line | Target | Repoint to |
| --- | --- | --- | --- |
| 1 | `features/layout/account-switcher.tsx:107` | `/accounts/{id}` | panel, Organization → General |
| 2 | `features/layout/account-switcher.tsx:213` | `/accounts/{id}` | same |
| 3 | `features/layout/user-menu.tsx:288` | `/accounts/{id}` | same |
| 4 | `features/projects/modal/project-create-modal.tsx:376` | `?tab=git` | Connected accounts |
| 5 | `features/projects/modal/github-setup-required-panel.tsx:72` | `?tab=git` | Connected accounts |
| 6 | `features/marketplace/add-to-project-modal.tsx:205` | `?tab=git` | Connected accounts |
| 7 | `customize/sections/view/members-view.tsx:1631` | `/accounts/{id}` | Members |
| 8 | `customize/sections/view/members-view.tsx:2533` | `?tab=roles` | Roles |
| 9 | `settings/tabs/connected-tab.tsx:465` | `?tab=git` | **decide: repoint or delete** |

Linker 9 was created by this effort and is now near-redundant — both cards from the `git`
pane live in Connected accounts as of JAY-545. Removing it outright is acceptable; leaving it
pointing at a deleted route is not.

Note linkers 7 and 8 live in `members-view.tsx`, which is already unreachable. Repoint them
anyway or delete them with the file — but say which, with a grep.

**Mandatory pre-step, before deleting anything.** Re-run the reachability sweep over every
`@/components/iam/` import in `[id]/page.tsx` and every component defined locally inside it:

```
grep -n "@/components/iam/" "apps/web/src/app/(app)/accounts/[id]/page.tsx"
# then for each symbol:
grep -rn "\bSYMBOL\b" apps/web/src --include="*.tsx" --include="*.ts"
```

Any symbol whose only mount is this page is an unfiled orphan. **Stop and report it rather
than deleting.** This sweep has already caught five orphans in this effort; the file also
defines many local components (`MembersCard`, `GeneralCard`, `DangerZoneCard`, …) that die
with it — confirm each is either rehomed or genuinely dead.

**Paste the sweep's real output in your report.** Three reports in this effort have cited a
grep that could not match what it claimed (an aliased import; a malformed pattern;
`grep -v test` described as filtering comments). Re-run every grep you cite.

**Also sweep the reverse direction:** any producer still calling `openSettings`, `router.push`,
or `<Link>` into a route you deleted. A producer firing into a missing consumer is silent —
it already shipped twice here.

- [ ] **Step 1: Inventory.** List all nine files, each one's live callers, and for the five
route moves the destination path. Report before proceeding.
- [ ] **Step 2: Reachability sweep**, both directions. Paste real output.
- [ ] **Step 3: Recreate the five routes** under `/settings/`, preserving each page's gate
exactly. Do not re-derive a gate from a variable in scope.
- [ ] **Step 4: Repoint all nine linkers**, plus the two wizard pushers in `sso-card.tsx` /
`scim-card.tsx`.
- [ ] **Step 5: Delete the four pure-deletion files** and the four moved originals.
- [ ] **Step 6: Confirm `grep -c "sso-setup" apps/web/src/features/sso-setup/guides.ts` still
returns 70**, and that `apps/web/public/sso-setup/` is untouched (`git status` shows nothing
under it).
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss from 5146; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 18: Workspace General, and extracting Experimental

**Files:** Create `apps/web/src/features/workspace/settings/tabs/general-tab.tsx` and
`tabs/experimental-tab.tsx`; tests alongside. Modify
`apps/web/src/features/workspace/customize/sections/view/settings-view.tsx` and
`settings-panel.tsx`.

**Interfaces:** Produces `GeneralTab({ projectId })` / `ExperimentalTab({ projectId })`, each
with a pure `*View` a `renderToStaticMarkup` test can render.

**Scope — workspace only.** This tab is the **project/workspace** surface built from
`settings-view.tsx`. The account-scoped Settings pane on the legacy page
(`app/(app)/accounts/[id]/page.tsx:621-685` — account General, Security/MFA, Enterprise
features, account Danger zone) is **not** part of this task; it is JAY-546 and lands in its
own tab. Do not pull any of it in. Two scopes and two danger zones on one page is the thing
that ticket exists to avoid.

**The split:**
- **General** — workspace name, icon, description, the sandbox-provider pin, and Delete
  workspace. Does **not** render the experimental feature list.
- **Experimental** — one row per `experimental_features` catalog entry with its stability
  badge. Move `ExperimentalCard` out of `settings-view.tsx` rather than copying it; a copy
  leaves two implementations to drift.

**Both tabs are project-scoped**, so they take `projectId`, not an account id, and get **no**
`ACCOUNT_TAB_PERMISSION` entry — that map is for account-permission tabs only. Confirm how
the sibling project-scoped panes (`secrets`, `channels`) resolve `projectId` in
`settings-panel.tsx` and follow it exactly.

**Do not fetch on mount.** `SettingsTabPane` gates on `if (!active) return null;` — use that,
add nothing new.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first. Specifically: `Badge`
for the stability chips, never a hand-rolled span; `rounded-md` panels, flat with a border,
no shadow; danger zone is a **neutral** bordered row with a `destructive` button, never a red
panel fill; `ConfirmDialog` before Delete workspace; `Loading` for pending, never an icon;
`text-balance` on headings; `SettingsSectionHeader` for every section title.

**Testing constraint (hard):** apps/web has NO DOM testing library — no
`@testing-library/react`, no jsdom, no happy-dom, and none may be added. `bun:test` +
`renderToStaticMarkup` against the pure views, every test asserting on markup.

- [ ] **Step 1: Enumerate** what `settings-view.tsx` renders today and which parts move where.
- [ ] **Step 2: Failing tests** — General renders name, icon, description, the sandbox
provider pin, and Delete workspace, and does **not** render the experimental list;
Experimental renders one row per catalog entry with its badge.
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement**, moving `ExperimentalCard` and the sandbox-provider row out of
`settings-view.tsx`.
- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Wire both into the panel.** Check whether any caller still reaches the old
combined view; if `settings-view.tsx` becomes unreachable, say so with a grep rather than
assuming.
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 19: Unified Members table

**Files:** Create `apps/web/src/features/workspace/settings/tabs/members-tab.tsx`,
`tabs/member-access-label.ts`; tests alongside. Modify `settings-panel.tsx`.

**Interfaces:** Produces `memberAccessLabel(m: ProjectAccessMember): { role: string; via: string | null }`.

**This task owns an orphan.** `ACCOUNT_ROLE_DESCRIPTORS`
(`components/iam/project-role-descriptors.ts`) is referenced only by the legacy page's
members pane — `app/(app)/accounts/[id]/page.tsx:1262`, `:2014-2018`, `:2354-2360` — where it
supplies the owner / admin / member role explainer copy. A later task deletes that page. An
unreachable component still compiles, so `tsc` stays at 17 and nothing goes red. Carry that
copy into this tab, and confirm with a grep that nothing else mounts it. Do **not** modify
`project-role-descriptors.ts` itself; the live page still imports it.

**One list is correct, not a compromise.** `apps/api/src/projects/routes/r6.ts:240` selects
`.from(accountMembers).where(eq(accountMembers.accountId, …))` for the whole account, then
left-joins project and group grants. Every account member comes back already carrying
`account_role`, `project_role`, `effective_project_role`, and `effective_source`. Two lists
would be two renderings of one query.

**Do not fetch on mount.** `SettingsTabPane` gates on `if (!active) return null;`.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first. Specifically: `Badge`
for role chips, never a hand-rolled span; `UserAvatar` + `InlineMeta` for the person cell
(see `members-view.tsx`); `rounded-md` panels flat with a border; `ConfirmDialog` before any
remove; `Loading` for pending, never an icon; `tabular-nums` on any date column;
`SettingsSectionHeader` for the heading.

**Testing constraint (hard):** apps/web has NO DOM testing library — no
`@testing-library/react`, no jsdom, no happy-dom, and none may be added. The label logic is
pure and tests directly; the table tests via `renderToStaticMarkup`.

**Provenance:** assert where something is used only with a quote or `file:line`.

**Gates:** tsc → **17**; `bun test src/` → no net loss; eslint clean.

- [ ] **Step 1: Write the failing test for the pure label logic first** — it is the part with real branching, and it is testable without mounting a table.

```ts
import { describe, expect, test } from 'bun:test';
import { memberAccessLabel } from './member-access-label';

const member = (o: Partial<ProjectAccessMember>): ProjectAccessMember => ({
  user_id: 'u1', email: 'a@b.c', account_role: 'member',
  project_role: null, effective_project_role: null, has_implicit_access: false,
  effective_source: null, group_sources: [], joined_at: '', granted_by: null,
  granted_at: null, updated_at: null, ...o,
});

describe('memberAccessLabel', () => {
  test('an account admin reads as implicit', () => {
    expect(memberAccessLabel(member({
      account_role: 'admin', effective_project_role: 'manager',
      effective_source: 'implicit', has_implicit_access: true,
    }))).toEqual({ role: 'Manager', via: 'account admin' });
  });

  test('a group grant names the group', () => {
    expect(memberAccessLabel(member({
      effective_project_role: 'editor', effective_source: 'group',
      group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
    }))).toEqual({ role: 'Editor', via: 'via Engineering' });
  });

  test('a direct grant carries no annotation', () => {
    expect(memberAccessLabel(member({
      project_role: 'viewer', effective_project_role: 'viewer', effective_source: 'direct',
    }))).toEqual({ role: 'Viewer', via: null });
  });

  test('no access reads as an em dash', () => {
    expect(memberAccessLabel(member({}))).toEqual({ role: '—', via: 'no access' });
  });

  test('the first group source wins when several contribute', () => {
    expect(memberAccessLabel(member({
      effective_project_role: 'editor', effective_source: 'group',
      group_sources: [
        { group_id: 'g1', group_name: 'Engineering', role: 'editor' },
        { group_id: 'g2', group_name: 'Viewers', role: 'viewer' },
      ],
    })).via).toBe('via Engineering');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `memberAccessLabel`.**
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Write the failing table test** — one row per person, an Account role column and a Workspace access column, account writes gated on `member.invite`/`member.update`/`member.remove` and workspace writes on `project.member.write`, with pending invites and access requests below.
- [ ] **Step 6: Implement the table**, reading `listProjectAccess`. Do **not** add a second query for account members — `GET /projects/:id/access` already returns every account member (`r6.ts:240`).
- [ ] **Step 7: Run to verify it passes.**
- [ ] **Step 8: Commit**

---

### Task 20: Split Sandbox and Snapshots

**Files:** Create `apps/web/src/features/workspace/settings/tabs/sandbox-tab.tsx` and
`tabs/snapshots-tab.tsx`; tests alongside. Modify `settings-panel.tsx`. Delete
`apps/web/src/features/workspace/customize/sections/view/sandbox-view.tsx` once both are
green **and** nothing imports it.

**Interfaces:** Produces `SandboxTab({ projectId })` / `SnapshotsTab({ projectId })`, each
with a pure `*View` a `renderToStaticMarkup` test can render.

**The current state, verified:** `sandbox-view.tsx` is **858 lines** rendering two unrelated
things — sandbox template CRUD and the snapshot build log. It has exactly one mount,
`settings-panel.tsx:1127` (`case 'sandbox'`). `snapshots` currently falls through to a
placeholder; `settings-panel.tsx:1000-1003` records why: mounting `SandboxView` on both tabs
would render the build log twice.

**The split:**
- **Sandbox** — template list, create, edit, delete. **No build log.**
- **Snapshots** — the build log, status, error categories, and the `isProjectAcceleratorBuild`
  filter. **No template form.**
- `isProjectAcceleratorBuild`, `CATEGORY_LABEL`, and `BUILD_SOURCE_LABEL` go with the
  **Snapshots** half.

**Both tabs are project-scoped**, so they take `projectId` and get **no**
`ACCOUNT_TAB_PERMISSION` entry. Note `snapshots` is deliberately excluded from
`ACCOUNT_SCOPED_SETTINGS_TABS` — confirm it stays excluded so the project-less rail keeps
filtering it.

**Move, do not copy.** A copy leaves two implementations of an 858-line surface to drift.
Preserve each half's gate exactly as `sandbox-view.tsx` passes it today; do not re-derive one
from a variable in scope.

**Do not fetch on mount.** `SettingsTabPane` gates on `if (!active) return null;` — use it.

**Reachability, both directions, before you finish.** After the split, confirm nothing
imports `sandbox-view.tsx` (check default AND named imports, and barrels), and that no
producer still targets a helper you moved. Six orphans have been found this way in this
effort; unreachable code compiles, so `tsc` stays at 17 and nothing goes red.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first. Specifically: `Badge`
per build status, never a hand-rolled span; `rounded-md` panels flat with a border,
`rounded-sm` status tiles; `Loading` for pending, never an icon and never `animate-spin`;
`tabular-nums` on build timestamps and durations; `ConfirmDialog` before template delete;
`SettingsSectionHeader` for each heading.

**Testing constraint (hard):** apps/web has NO DOM testing library — no
`@testing-library/react`, no jsdom, no happy-dom, and none may be added. `bun:test` +
`renderToStaticMarkup`, every test asserting on markup. Note `DropdownMenuContent` renders
**nothing** under `renderToStaticMarkup` while closed (verified empirically in this effort) —
if a control needs to be test-covered, it cannot live behind a closed dropdown.

**Provenance:** quote or `file:line`, and **re-run the grep you cite, printing line content**.
`grep -rl` proves a file *contains* a string, never that it *calls* a function.

- [ ] **Step 1: Enumerate** what `sandbox-view.tsx` renders and which half each piece belongs to.
- [ ] **Step 2: Failing tests** — Sandbox renders template CRUD and no build log; Snapshots
renders the build log, status, error categories, and the `isProjectAcceleratorBuild` filter,
and no template form.
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement the split.**
- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Wire both into `settings-panel.tsx`**, replacing the `sandbox` case and the
`snapshots` placeholder. Delete `sandbox-view.tsx` and prove with a grep that nothing imports it.
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss from 5175; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 21: Instructions tab — Commands wiring, and the instructions question

**Files:** Create `apps/web/src/features/workspace/settings/tabs/instructions-tab.tsx`; test
alongside. Modify `settings-panel.tsx`, and whichever of `menu-registry.ts` /
`settings-tabs.ts` the wiring needs.

**Current state, verified:** `settings-panel.tsx:1122-1123` already mounts
`case 'instructions': return <CommandsView projectId={projectId} />;`. So the tab exists and
shows commands — it just has no instructions half, and the redirect/palette wiring is
unproven.

**Scope note — read before building.** The spec (`…-design.md:299`, `:455-457`) describes this
tab as "agent instructions + `commands-view.tsx` folded in". **There is no dedicated
agent-instructions surface in the codebase.** The nearest thing is a per-agent "System prompt"
field inside the agent editor (`agent-editor-basics-fields.tsx:324`, help text: "Replaces the
default instructions for this agent"), which belongs to one agent, not the project.

So **do not invent an instructions editor to satisfy the spec sentence.** Step 1 is an
investigation with evidence. If a project-level instructions surface genuinely exists, mount
it. If it does not, say so with greps and build only the parts below — a fabricated editor
writing to a field that does not exist is worse than a documented gap.

**What is concrete and must ship:**
1. `commands-view.tsx` stays mounted on this tab. **Do not delete it** — its standalone page
   was deleted in #6169, so this overlay is its only reachable surface.
2. `/customize/commands` redirects to the Instructions tab.
3. The `proj-commands` palette entry (`menu-registry.ts:451`) resolves to this tab.

Verify 2 and 3 against the live code before changing anything — one or both may already work.
Report which were already correct and which you fixed, with `file:line`.

**Do not fetch on mount.** `SettingsTabPane` gates on `if (!active) return null;`.

**Reachability, both directions.** Confirm `CommandsView` keeps a live mount, and that no
producer fires at a route or tab id you changed. Unreachable code compiles — `tsc` stays at
exactly 17 and nothing goes red. Six orphans have been found this way in this effort.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first: `SettingsSectionHeader`
for each section heading, `rounded-md` panels flat with a border, `Badge` not hand-rolled
chips, `Loading` for pending.

**Testing constraint (hard):** apps/web has NO DOM testing library — none may be added.
`bun:test` + `renderToStaticMarkup`, every test asserting on markup.

**Provenance:** quote or `file:line`, and **re-run the grep you cite, printing line content**.
`grep -rl` proves a file *contains* a string, never that it *calls* a function.

- [ ] **Step 1: Investigate the instructions surface** and report with evidence whether a
project-level one exists. Do not build one that does not.
- [ ] **Step 2: Verify** the current behaviour of the `/customize/commands` redirect and the
`proj-commands` palette entry. Report which already work.
- [ ] **Step 3: Failing test** — the tab renders the commands list; the redirect resolves here;
the palette entry resolves to this tab.
- [ ] **Step 4: Run to verify it fails.**
- [ ] **Step 5: Implement** only what Step 1 and 2 showed is missing.
- [ ] **Step 6: Run to verify it passes.**
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss from 5192; eslint clean.
- [ ] **Step 8: Commit**

---

### Task 22: Rebuild the Models connect surface

**Files:** Create `apps/web/src/features/providers/provider-connect.tsx` (the one shared
component) and `apps/web/src/features/workspace/settings/tabs/models-tab.tsx`; tests
alongside. Modify the model selector's connect dialog to mount the same component.

**This is the largest task in the plan.** Baseline: **3,206 lines across 11 files**, with
`features/providers/connect-provider-content.tsx` alone at **1,076**. Connecting an Anthropic
key — the single most common action a new user takes — currently costs a modal, an accordion
expand, and a search field.

**The target shape**, four sections in `provider-connect.tsx`:
1. **Connected** — what is already wired.
2. **Add a provider** — the three first-class providers as **inline rows**, each one field and
   one button. No modal, no disclosure, no search to get to them.
3. **More providers** — a `Disclosure` that *holds* the search. Search lives inside it, not
   above it.
4. **Custom provider** — the escape hatch, last.

**Reuse the data that already encodes the simple model.** `PROVIDER_NOTES` and
`POPULAR_PROVIDER_IDS` in `features/providers/provider-branding.tsx` already say which
providers are first-class and what the subscription wording is. Use them verbatim — do not
rewrite the copy.

**One component, mounted twice.** The models tab and the model selector's connect dialog both
mount `provider-connect.tsx`. A third copy is not acceptable — that is the defect this task
exists to remove.

**Testing constraint (hard) — the plan's original test code for this task was invalid.** It
used `render`, `userEvent`, and `getByLabelText` from `@testing-library/react`. **That library
is not installed and none may be added.** apps/web has no DOM testing library — no jsdom, no
happy-dom. Write the tests as `bun:test` + `renderToStaticMarkup` against a pure
`ProviderConnectView`, asserting on markup. Behaviour that genuinely needs a DOM (typing,
clicking) is tested by extracting the logic to a pure function and testing that instead.

Pin at least these, adapted to markup assertions:
- the three first-class providers render **without** any disclosure or search;
- the search input appears **inside** the More-providers disclosure, not above it;
- the subscription wording matches `PROVIDER_NOTES` exactly;
- connecting takes one field and one button — no `role="dialog"` in the models-tab path.

**Deletion is part of this task, and it is where the risk is.** Step 5 deletes the superseded
parts of `connect-provider-content.tsx`. Before deleting anything, sweep both directions:
every symbol that file exports or defines locally, and every producer that reaches it.
Unreachable code compiles — `tsc` stays at exactly **17** and no test goes red — so an
orphaned capability ships silently. **Six orphans have been found this way in this effort. If
a capability has no home after the rebuild, STOP and report it rather than dropping it.**

**Never re-derive a gate.** Preserve each moved surface's original permission source exactly.

**Provenance:** quote or `file:line`, and **re-run the grep you cite, printing line content**.
`grep -rl` proves a file *contains* a string, never that it *calls* a function.

**Design bar applies.** Load `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md` first: `Badge` for status chips
never a hand-rolled span; `rounded-md` panels flat with a border; `Field`/`FieldLabel` +
`InputGroup` for the key inputs; `Disclosure` for More providers; `Loading` for pending never
an icon; `ConfirmDialog` before disconnecting a provider; `SettingsSectionHeader` per section.
Note `DropdownMenuContent` renders nothing under `renderToStaticMarkup` while closed — a
control that must be test-covered cannot live behind a closed dropdown.

- [ ] **Step 1: Inventory** the 11 files and 3,206 lines: what each does, and which of the four
sections it maps to. Report before building.
- [ ] **Step 2: Failing tests** per the list above, `renderToStaticMarkup` only.
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement `provider-connect.tsx`** with the four sections.
- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Mount the same component** in the models tab and in the model selector's
connect dialog. Then sweep both directions before deleting the superseded parts.
- [ ] **Step 7: Prove the line count fell.** Run
`cd apps/web && wc -l src/features/providers/*.tsx src/features/workspace/settings/tabs/models-tab.tsx`
and record the real number against the 3,206 baseline.
- [ ] **Step 8: Gates.** tsc → **17**; `bun test src/` → no net loss from 5195; eslint clean.
- [ ] **Step 9: Commit**

---

### Task 23: Mobile rail

**Files:** Modify `settings-panel.tsx`; test alongside.

- [ ] **Step 1: Write the failing test** — under `useIsMobile`, the rail renders as a horizontal scrolling `TabsList` with a close control, and every tab remains reachable.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**, restyling the existing `FadedScrollArea` tail onto the new primitive. No new navigation model.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Verify at 375px and 768px in the browser.** Screenshot both.
- [ ] **Step 6: Commit** (ask first)

---

### Task 24: Accessibility, motion, and empty/error states

- [ ] **Step 1: Load the `animations-dev` skill** before writing any motion.
- [ ] **Step 2: Write the failing test** — every pane has an accessible name; ↑/↓ move within a group and Tab exits; no tab trigger is an orphan tab stop.
- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.** Every tab needs a real empty state and a real error state — no bare spinners, and never a spinning icon.
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Run the full gate**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -30
npx eslint src/features/workspace/settings src/components/ui/tabs.tsx src/components/ui/settings-section-header.tsx
bun test src/
```

Expected: tsc clean apart from the ~15 known `@types/bun` errors; eslint no errors; tests pass.

- [ ] **Step 7: Commit** (ask first)

---

### Task 25: End-to-end and dev verification

Per `CLAUDE.md`, a local pass and a dev pass are both required and neither replaces the other.

- [ ] **Step 1: Drive every tab in the real browser.** For each of the 26, click the trigger, observe the network request, and assert the visible result plus the outgoing payload.
- [ ] **Step 2: Verify the negative paths explicitly.**
  - A role missing a read leaf does not see that tab.
  - A non-entitled account sees `EnterpriseUpsell`, not the IAM pane.
  - Every legacy URL from Task 6 and Task 17 lands on the right tab.
  - The panel opens with no project selected and the You / Organization / Developer tabs work.
- [ ] **Step 3: Open the PR**, wait for required checks, merge to `main`. No Linear id or URL anywhere in the branch, commits, title, or body.
- [ ] **Step 4: Follow the Deploy Dev workflow to completion.** Confirm the deployed artifact contains the merged SHA — a `/health` 200 alone is not deployment proof.
- [ ] **Step 5: Re-run the user-visible behaviour against `https://dev.kortix.com`.** Record the exact interaction and its result.
- [ ] **Step 6: Post the evidence** — PR, merge SHA, deploy run, deployed SHA, and the dev commands — into the Linear issues before closing any of them.

---

## Self-review

**Spec coverage.** Every spec section maps to a task: shell → 1, 5; header primitive → 2; IA → 3, 4; You → 7–10; Organization → 11–17; Workspace → 18, 19; Agent → 20–22; routes → 6; `/accounts` deletion → 14, 17; permission gating → 5, 13, 14, 15; mobile → 23; verification → 24, 25. Channels needs no task of its own — `channels-view.tsx` already exists and Task 4 places it in the rail.

**Two tasks are gated on a user decision and say so:** Task 9 (Connected accounts scope) and Task 16 (API keys pagination). Task 14 gates Task 17 on a verification, not an assumption.

**Type consistency.** `SettingsTab` is the tab-id type throughout; `RailItem.tab` (not `.section`) after Task 4; the store exposes `tab` / `setTab` / `openSettings` after Task 5; `memberAccessLabel` returns `{ role, via }` in Tasks 19.

**Known gap, stated rather than hidden.** Radix `TabsList` cannot hold non-trigger children, so Task 5 renders one `TabsList` per group. Arrow-key roving therefore moves *within* a group, not across the whole rail. This is a real behavioural limit of the grouped design, not an oversight; Task 5 Step 3 says to confirm it and raise crossing-group navigation as a follow-up rather than silently dropping the group labels.

### Task 26: Organization General tab (JAY-546)

**Files:** Create `apps/web/src/features/workspace/settings/tabs/organization-tab.tsx`; test
alongside. Modify `settings-tabs.ts` (add the `organization` member), `rail.ts`, and
`settings-panel.tsx`.

**Interfaces:** Produces `OrganizationTab({ accountId? })` and a pure `OrganizationTabView`.

**User decision, 2026-08-10 — this is settled, do not re-open.** A **new 27th tab**, id
`organization`, label **"General"**, placed **first in the Organization group**, before
Billing. Jay chose this over folding into Workspace → General, because that would put two
scopes and two danger zones (delete workspace AND delete organization) on one page.

**Source — mount, do not reimplement.** The live pane is
`app/(app)/accounts/[id]/page.tsx:621-685`, four `SettingsGroup`s under
`activeSection === 'settings' && canWriteAccount`:

| Order | Group | Contents | Extra gate |
| --- | --- | --- | --- |
| 1 | General | `GeneralCard` | — |
| 2 | Security | `MfaRequiredCard`, then an `Advanced` `Disclosure` (closed) wrapping `SessionControlsCard` | — |
| 3 | Enterprise features | `EnterpriseDemoCard` | `!entitlementsLoading && !accountStateQuery.data?.enterprise_license_available` |
| 4 | Danger zone | `DangerZoneCard` | `canDeleteAccount` |

Preserve the `Advanced` disclosure closed-by-default. The comment at `page.tsx:631-635`
gives the reason: MFA is the one control most accounts touch; session lifetime and idle
timeout are compliance-shop noise. Do not promote it.

The Enterprise group's **negative** gate is deliberate (`page.tsx:662-668`): when a self-host
operator's Enterprise licence already forces every entitlement on, there is nothing to
demo-toggle, so the group hides entirely. Reproduce it exactly — do not simplify it to a
positive check.

**Gate:** `account.write` (`page.tsx:621`). Add `organization: 'account.write'` to
`ACCOUNT_TAB_PERMISSION`; that auto-extends the rail loop tests.

**This task closes four of JAY-505's orphans.** `GeneralCard`, `MfaRequiredCard`,
`SessionControlsCard`, `EnterpriseDemoCard`, and the account `DangerZoneCard` are mounted
only on the page JAY-505 deletes. Do **not** modify any of them — that page still imports
them until the deletion lands. Verify each has a live mount here before you finish, and
re-run the grep you cite.

**Do not fetch on mount.** `SettingsTabPane` gates on `if (!active) return null;`.

**Design bar applies.** `Badge` for chips; `rounded-md` panels flat with a border; the danger
zone is a **neutral** bordered row with a `destructive` button, never a red panel fill;
`ConfirmDialog` before the destructive mutation; `Loading` for pending, never an icon;
`SettingsSectionHeader` for each group heading.

**Account id:** `useSettingsAccountId`. **Provenance:** quote or `file:line`, and the grep
you cite must actually match.

- [ ] **Step 1: Enumerate** the four groups and each one's gate from the live source.
- [ ] **Step 2: Failing test** — `renderToStaticMarkup` against `OrganizationTabView`,
pinning group order, the closed-by-default Advanced disclosure, the Enterprise negative gate,
and the danger zone appearing only under `canDeleteAccount`.
- [ ] **Step 3: Run to verify it fails.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Wire the tab** into `settings-tabs.ts`, `rail.ts` (first in Organization), and
`settings-panel.tsx` + `ACCOUNT_TAB_PERMISSION`.
- [ ] **Step 7: Gates.** tsc → **17**; `bun test src/` → no net loss; eslint clean.
- [ ] **Step 8: Commit**

---
