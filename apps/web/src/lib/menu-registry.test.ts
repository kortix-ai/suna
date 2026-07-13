import { describe, expect, test } from 'bun:test';

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
