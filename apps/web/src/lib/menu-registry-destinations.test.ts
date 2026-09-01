import { describe, expect, test } from 'bun:test';
import { VALID_TABS } from '@/features/accounts/hub/sections';

import {
  CAPABILITY_TABS,
  capabilityTabHref,
  channelsHref,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  ALL_PROJECT_SETTINGS_SECTIONS,
  projectSettingsSectionHref,
} from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { SUBMENU_PAGE_BY_ID } from '@/features/workspace/command-palette';
import { LEGACY_PALETTE_HIDDEN } from '@/features/workspace/command-palette-visibility';
import { getItemsForSurface } from '@/lib/menu-registry';

/**
 * ============================================================================
 * EVERY DESTINATION IS REACHABLE FROM ⌘K.
 * ============================================================================
 *
 * `command-palette-search.test.ts` pins what a row is searchable BY. This file
 * pins that a row EXISTS for each destination in the first place — the other
 * half of the same defect, and the half nothing was checking.
 *
 * The reported symptom: typing "model" opened project Settings and the
 * settings overlay, never the Models page. Models had graduated out of the
 * Settings overlay into `/projects/<id>/models` months earlier and simply
 * never got a registry row; the only row that owned the word was
 * `proj-customize`, whose keyword bag was the concatenated vocabulary of
 * thirteen pages and whose href went to `/config`. Secrets, Channels and
 * Members were in the same state, and none of the six `/config` sections was
 * separately addressable at all.
 *
 * A hand-written list drifts — this repo has now watched it drift twice (see
 * `settings-palette-items.ts`'s header for the first). Rather than derive the
 * rows and lose the per-row keyword curation that makes the palette accurate,
 * the list stays hand-written and this file makes the drift a red test:
 * adding a `CapabilityTab`, a `ProjectSettingsSection`, or an account section
 * fails here until it is given a row.
 *
 * `{projectId}` / `{accountId}` are the registry's own tokens, resolved at
 * render by `allPaletteItems` in `command-palette.tsx`; a row still holding an
 * unresolved token there is dropped rather than navigated to. Comparing the
 * unresolved hrefs is therefore comparing exactly what ships.
 */

const PROJECT_TOKEN = '{projectId}';
const ACCOUNT_TOKEN = '{accountId}';

const paletteRows = getItemsForSurface('commandPalette').filter(
  (item) => !LEGACY_PALETTE_HIDDEN.has(item.id),
);

/** Every href the palette can offer, unresolved. */
const paletteHrefs = new Set(
  paletteRows.filter((item) => item.kind === 'navigate' && item.href).map((item) => item.href!),
);

function rowFor(href: string) {
  return paletteRows.find((item) => item.href === href) ?? null;
}

describe('every capability tab has a palette row', () => {
  for (const tab of CAPABILITY_TABS) {
    test(`"${tab.label}" (/${tab.key}) is reachable`, () => {
      const href = capabilityTabHref(PROJECT_TOKEN, tab.key);
      expect({ tab: tab.key, href, hasRow: paletteHrefs.has(href) }).toEqual({
        tab: tab.key,
        href,
        hasRow: true,
      });
    });

    test(`"${tab.label}" declares requiresProject, so its token always resolves`, () => {
      const row = rowFor(capabilityTabHref(PROJECT_TOKEN, tab.key));
      expect(row?.requiresProject).toBe(true);
    });
  }

  test('Channels is reachable at its scope of the Connectors page', () => {
    // Channels is not a `CapabilityTab` — it is `?scope=channels` on
    // Connectors — but it is a destination a person names ("slack", "inbox"),
    // so it gets a row like any other.
    expect(paletteHrefs.has(channelsHref(PROJECT_TOKEN))).toBe(true);
  });
});

describe('every project settings section has a palette row', () => {
  for (const section of ALL_PROJECT_SETTINGS_SECTIONS) {
    test(`"${section.label}" (?section=${section.key}) is reachable`, () => {
      const href = projectSettingsSectionHref(PROJECT_TOKEN, section.key);
      expect({ section: section.key, href, hasRow: paletteHrefs.has(href) }).toEqual({
        section: section.key,
        href,
        hasRow: true,
      });
    });
  }

  test('the flag-gated section carries the same flag its section does', () => {
    expect(rowFor(projectSettingsSectionHref(PROJECT_TOKEN, 'review'))?.requiresFlag).toBe(
      'review_center',
    );
  });
});

describe('every account section has a palette row', () => {
  /**
   * `VALID_TABS` used to be a private `const … as const` inside
   * `/accounts/[id]/page.tsx`, so this read the page's source and parsed it
   * with a regex — importing the page drags every IAM tab module in with it.
   * The allowlist is an exported constant of the hub catalog now
   * (`features/accounts/hub/sections.ts`), which imports only icons, so the
   * join is a plain import and cannot silently stop matching.
   */
  test('the allowlist is not empty', () => {
    expect(VALID_TABS.length).toBeGreaterThan(0);
  });

  for (const tab of VALID_TABS) {
    test(`?tab=${tab} is reachable`, () => {
      const href = `/accounts/${ACCOUNT_TOKEN}?tab=${tab}`;
      expect({ tab, href, hasRow: paletteHrefs.has(href) }).toEqual({ tab, href, hasRow: true });
    });
  }
});

describe('the two rows that answer in-palette instead of navigating', () => {
  test('"Review changes" and "Feature flags" open a palette page, and both ids are real rows', () => {
    // `SUBMENU_PAGE_BY_ID` is keyed by registry id, and a typo there fails
    // silently — the row falls through to its `kind` branch and navigates
    // instead. Pin both directions: every key names a live palette row, and
    // the two rows this change added map to the pages they promise.
    expect(SUBMENU_PAGE_BY_ID['review-changes']).toBe('changes');
    expect(SUBMENU_PAGE_BY_ID['proj-config-feature-flags']).toBe('flags');
    for (const id of Object.keys(SUBMENU_PAGE_BY_ID)) {
      expect({ id, isRow: paletteRows.some((item) => item.id === id) }).toEqual({
        id,
        isRow: true,
      });
    }
  });

  test('every submenu row still declares a routed fallback or an action', () => {
    // A surface that consumes this registry WITHOUT the palette's nested
    // picker (the right sidebar) has to have somewhere to send the click.
    for (const id of Object.keys(SUBMENU_PAGE_BY_ID)) {
      const row = paletteRows.find((item) => item.id === id)!;
      expect({ id, resolvable: Boolean(row.href || row.actionId) }).toEqual({
        id,
        resolvable: true,
      });
    }
  });
});

describe('the destinations that need a resolved id at runtime', () => {
  test('"Workspace members" is an action, because its account id is a network read', () => {
    // `/projects/<id>/members` only redirects; the real destination is the
    // OWNING account's Access pane scoped back to the workspace, and that
    // account id lives on the project detail. A `kind: 'navigate'` row cannot
    // express that, so this row is an action — see `openProjectMembers` in
    // command-palette.tsx.
    const row = paletteRows.find((item) => item.id === 'proj-members');
    expect(row?.kind).toBe('action');
    expect(row?.actionId).toBe('openProjectMembers');
    expect(row?.requiresProject).toBe(true);
  });

  test('"Review changes" is a workspace action, not a session one', () => {
    // A change request belongs to the workspace, not to the session that
    // produced it — gating it on a session would hide it on every project
    // route that is not a session.
    const row = paletteRows.find((item) => item.id === 'review-changes');
    expect(row?.requiresProject).toBe(true);
    expect(row?.requiresSession).toBeUndefined();
  });
});
