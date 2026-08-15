import { describe, expect, test } from 'bun:test';

import { resolveSettingsOverlayHref } from '@/features/workspace/settings/settings-tabs';

import { getItemsForSurface, type MenuItemDef } from './menu-registry';
import { WALLPAPERS } from './wallpapers';

function matchesPaletteQuery(item: MenuItemDef, query: string): boolean {
  const haystack = [item.label, item.id, item.group, item.keywords || ''].join(' ').toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const paletteItems = getItemsForSurface('commandPalette');
const wallpaperItems = paletteItems.filter((item) => item.kind === 'wallpaper');

describe('wallpaper command palette items', () => {
  test('every wallpaper has a palette item applying it', () => {
    for (const wp of WALLPAPERS) {
      const item = wallpaperItems.find((i) => i.wallpaperValue === wp.id);
      expect(item).toBeDefined();
      expect(item!.id).toBe(`wallpaper-${wp.id}`);
      expect(item!.label).toContain(wp.name);
    }
  });

  test('typing a wallpaper display name surfaces its item', () => {
    for (const wp of WALLPAPERS) {
      const hits = wallpaperItems.filter((item) => matchesPaletteQuery(item, wp.name));
      expect(hits.map((i) => i.wallpaperValue)).toContain(wp.id);
    }
  });

  test('typing a wallpaper id surfaces its item', () => {
    for (const wp of WALLPAPERS) {
      const hits = wallpaperItems.filter((item) => matchesPaletteQuery(item, wp.id));
      expect(hits.map((i) => i.wallpaperValue)).toContain(wp.id);
    }
  });

  test('typing "wallpaper" surfaces every wallpaper item', () => {
    const hits = wallpaperItems.filter((item) => matchesPaletteQuery(item, 'wallpaper'));
    expect(hits.length).toBe(WALLPAPERS.length);
  });

  test('shader wallpapers are findable via "shader"', () => {
    const shaderIds = WALLPAPERS.filter((wp) => wp.type === 'shader').map((wp) => wp.id);
    const hits = wallpaperItems.filter((item) => matchesPaletteQuery(item, 'shader'));
    expect(hits.map((i) => i.wallpaperValue).sort()).toEqual([...shaderIds].sort());
  });

  test('wallpaper item ids are unique', () => {
    const ids = wallpaperItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('toggle-panel-mode command palette item', () => {
  const panelModeItem = paletteItems.find((item) => item.id === 'toggle-panel-mode');

  test('is registered for the command palette with the right action wiring', () => {
    expect(panelModeItem).toBeDefined();
    expect(panelModeItem!.kind).toBe('action');
    expect(panelModeItem!.actionId).toBe('togglePanelMode');
    expect(panelModeItem!.requiresSession).toBe(true);
  });

  test('typing "easy" surfaces the item', () => {
    expect(panelModeItem).toBeDefined();
    expect(matchesPaletteQuery(panelModeItem!, 'easy')).toBe(true);
  });

  test('typing "advanced" surfaces the item', () => {
    expect(panelModeItem).toBeDefined();
    expect(matchesPaletteQuery(panelModeItem!, 'advanced')).toBe(true);
  });

  test('typing "panel" or "session" surfaces the item', () => {
    expect(panelModeItem).toBeDefined();
    expect(matchesPaletteQuery(panelModeItem!, 'panel')).toBe(true);
    expect(matchesPaletteQuery(panelModeItem!, 'session')).toBe(true);
  });
});

describe('project sessions command palette item', () => {
  test('falls back to the canonical project sessions page', () => {
    const sessionsItem = paletteItems.find((item) => item.id === 'proj-sessions');

    expect(sessionsItem).toBeDefined();
    expect(sessionsItem!.href).toBe('/projects/{projectId}/sessions');
  });
});

/**
 * `proj-commands` pointed at `/settings/instructions`. Both the entry and the
 * Instructions tab are gone. Two things are pinned here, because dropping the
 * entry alone is not enough to keep the palette honest:
 *
 *   1. No registry entry still advertises a `/settings/instructions` href.
 *      `resolveSettingsOverlayHref` now returns `{ opensOverlay: false }` for
 *      that path (`parseSettingsTab` rejects the segment), so a leftover entry
 *      would fall through to a plain `router.push` onto a route with no tab —
 *      a dead click, not a visible error.
 *   2. Typing "Commands" surfaces nothing. The word was already stripped from
 *      `proj-customize`'s keywords to stop it shadowing the real entry; with
 *      the real entry deleted, that removal is what keeps Customize from
 *      quietly inheriting the query.
 */
describe('project commands palette entry is gone with the Instructions tab', () => {
  test('no entry points at the removed Instructions tab', () => {
    expect(paletteItems.find((item) => item.id === 'proj-commands')).toBeUndefined();
    expect(paletteItems.some((item) => item.href?.includes('/settings/instructions'))).toBe(false);
    expect(resolveSettingsOverlayHref('/projects/p1/settings/instructions')).toEqual({
      opensOverlay: false,
    });
  });

  test('typing "Commands" no longer surfaces Customize as a stand-in', () => {
    const customizeItem = paletteItems.find((item) => item.id === 'proj-customize');
    expect(customizeItem).toBeDefined();
    expect(matchesPaletteQuery(customizeItem!, 'Commands')).toBe(false);

    // Deliberately NOT asserting "nothing matches 'Commands'". Two entries
    // still do, neither of them this change's business:
    //   - `restart-config` is an ACTION
    //     (`keywords: 'reload restart config agents skills commands'`) and
    //     matches correctly — reloading project config does reload commands.
    //   - `workspace` (`menu-registry.ts:665`) carries the word in its
    //     keywords and `activePathPrefixes`. It is a PRE-EXISTING dead entry:
    //     neither `/workspace` nor `/commands` exists under `src/app`, and it
    //     was already dead before the Instructions tab was removed. Left
    //     alone here on purpose — folding it into this test would hide it.
    // What this change owns is narrower: no PROJECT navigation entry offers
    // to take the user to a commands surface that no longer exists.
    const projectNavMatches = paletteItems
      .filter(
        (item) =>
          item.kind === 'navigate' &&
          item.requiresProject === true &&
          matchesPaletteQuery(item, 'Commands'),
      )
      .map((item) => item.id);
    expect(projectNavMatches).toEqual([]);
  });
});

describe('the capability panes are not shadowed by the Customize door', () => {
  // filteredNavItems (command-palette.tsx) preserves registry declaration
  // order rather than ranking by relevance, and 'proj-customize' is declared
  // before every row it could shadow. Customize's keywords used to include the
  // words "skills" and "commands", so it matched — and listed ahead of — the
  // real entries. Observed live: query "Skills" -> ["Customize", "Skills", …].
  //
  // Agents, Skills, Connectors and Apps have no registry row at all now: they
  // are Customize panes, and `settings-palette-items.ts` derives one row each
  // from the rail. So the shadowing rule is stated against the ONE row still
  // in the registry — the generic Customize door — which must not answer a
  // query naming a specific pane. That the panes themselves answer is pinned
  // in `command-palette-search.test.ts`.
  const customizeItem = paletteItems.find((item) => item.id === 'proj-customize');
  const policiesItem = paletteItems.find((item) => item.id === 'proj-connectors-policies');

  for (const query of ['Skills', 'Connectors', 'agents', 'apps']) {
    test(`typing "${query}" does not match the generic Customize door`, () => {
      expect(customizeItem).toBeDefined();
      expect(matchesPaletteQuery(customizeItem!, query)).toBe(false);
    });
  }

  test('no registry row duplicates a capability pane', () => {
    // Two rows for one destination is the defect this deletion fixed: the
    // registry row and the derived pane row both pointed at Apps, so "apps"
    // returned the same place twice.
    for (const id of ['proj-agents', 'proj-skills', 'proj-connectors', 'proj-apps']) {
      expect(paletteItems.find((item) => item.id === id)).toBeUndefined();
    }
  });

  test('proj-connectors-policies no longer advertises a Customize destination it cannot reach', () => {
    expect(policiesItem).toBeDefined();
    expect(policiesItem!.href).toBe('/projects/{projectId}/connectors');
    expect(policiesItem!.label).not.toContain('Customize');
  });
});
