import { VALID_TABS } from '@/features/accounts/hub/sections';
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPABILITY_TABS,
  capabilityTabHref,
  channelsHref,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  SETTINGS_TAB_SUBMENU_PAGE,
  SUBMENU_PAGE_BY_ID,
} from '@/features/workspace/command-palette';
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

/**
 * Every routable path under `src/app`, as a segment list.
 *
 * Route groups (`(app)`, `(capabilities)`) are stripped — they organize files,
 * not URLs — and a directory counts only when it holds a `page.tsx`, which is
 * what makes a path routable in the App Router. `[id]`, `[...slug]` and
 * `[[...slug]]` stay as-is and are matched structurally below.
 */
function collectRoutes(dir: string, segments: string[] = [], out: string[][] = []): string[][] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name === 'page.tsx')) out.push(segments);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A route group contributes no URL segment; `@slot` and `_private`
    // directories contribute no route at all.
    if (entry.name.startsWith('@') || entry.name.startsWith('_')) continue;
    const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
    collectRoutes(join(dir, entry.name), isGroup ? segments : [...segments, entry.name], out);
  }
  return out;
}

const APP_DIR = join(import.meta.dir, '..', 'app');
const ROUTES = collectRoutes(APP_DIR);

/**
 * One href's path against one route's segments.
 *
 * A literal segment must match exactly. A dynamic one (`[id]`) matches any
 * single segment, which is what lets the registry's own `{projectId}` and
 * `{accountId}` tokens stand in for the ids they are replaced by at render.
 * A catch-all (`[...slug]`) swallows the remainder; the optional form
 * (`[[...slug]]`) also matches a path that stops before it.
 */
function routeMatches(route: string[], path: string[]): boolean {
  let r = 0;
  for (const actual of path) {
    const segment = route[r];
    if (segment === undefined) return false;
    if (segment.startsWith('[[...') || segment.startsWith('[...')) return true;
    const isDynamic = segment.startsWith('[') && segment.endsWith(']');
    if (!isDynamic && segment !== actual) return false;
    r++;
  }
  if (r === route.length) return true;
  return route.length === r + 1 && route[r]!.startsWith('[[...');
}

/** Whether any route in `src/app` serves this href. */
function isLiveRoute(href: string): boolean {
  const path = href.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean);
  return ROUTES.some((route) => routeMatches(route, path));
}

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

describe('the flag-gated capability tab', () => {
  test('Review carries the same flag its tab does', () => {
    // `/projects/<id>/config` and its `?section=` rows are gone (2026-09-02);
    // its configuration sections are Settings-overlay tabs, whose palette rows
    // are DERIVED from the rail and covered by `command-palette.test.tsx`.
    // Review is the one section that became a capability tab, and its row
    // must hide exactly when the tab does.
    expect(rowFor(capabilityTabHref(PROJECT_TOKEN, 'review'))?.requiresFlag).toBe('review_center');
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
    // Feature flags is a derived settings row now, keyed by overlay tab.
    expect(SETTINGS_TAB_SUBMENU_PAGE['feature-flags']).toBe('flags');
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

/**
 * ============================================================================
 * THE OTHER DIRECTION: EVERY ROW POINTS AT A ROUTE THAT EXISTS.
 * ============================================================================
 *
 * Everything above pins that each destination HAS a row. Nothing pinned the
 * reverse, and that is the half a real defect walked through: `/projects/<id>/
 * config` was deleted on 2026-09-02, and `proj-config-feature-flags` kept
 * pointing at it until 2026-09-03. Typing "feature flag" offered that row
 * first, under Navigation, and selecting it navigated to a 404 instead of
 * opening the Feature flags pane.
 *
 * Deleting a route is the moment this breaks, and it breaks silently: the
 * registry is a plain data table, so no import goes red and no type narrows.
 * Reading `src/app` from disk is what makes the two facts one fact.
 */
describe('every palette row points at a live route', () => {
  test('the route table was actually found', () => {
    // A wrong `APP_DIR` would make every assertion below vacuously pass.
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(ROUTES.some((r) => r.join('/') === 'projects/[id]/files')).toBe(true);
  });

  test('/projects/[id]/config is gone, so nothing may point at it', () => {
    // The specific route this test exists because of.
    expect(isLiveRoute('/projects/{projectId}/config?section=feature-flags')).toBe(false);
  });

  for (const row of paletteRows.filter((item) => item.kind === 'navigate' && item.href)) {
    test(`"${row.label}" (${row.id}) → ${row.href}`, () => {
      expect({ id: row.id, href: row.href, live: isLiveRoute(row.href!) }).toEqual({
        id: row.id,
        href: row.href,
        live: true,
      });
    });
  }
});

describe('the retired /config sections are reached through the settings overlay', () => {
  test('no registry row keeps a /config href', () => {
    // Belt-and-braces over the loop above, and the assertion that names the
    // path rather than the row: a NEW row pointing at `/config` fails here
    // even if someone also re-adds the route.
    const offenders = paletteRows
      .filter((item) => item.href?.includes('/config'))
      .map((item) => item.id);
    expect(offenders).toEqual([]);
  });

  test('Feature flags is reachable, and only as the derived settings row', () => {
    // The row that answers "feature flag" now. It is derived from the rail
    // (`settings-palette-items.ts`) and opens the in-palette picker through
    // `SETTINGS_TAB_SUBMENU_PAGE`, never a URL — which is why it cannot rot
    // the way the registry row did.
    expect(SETTINGS_TAB_SUBMENU_PAGE['feature-flags']).toBe('flags');
    expect(paletteRows.some((item) => item.id === 'proj-config-feature-flags')).toBe(false);
  });
});
