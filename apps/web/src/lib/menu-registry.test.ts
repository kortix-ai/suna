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

describe('workspace sessions command palette item', () => {
  test('falls back to the canonical Workspace sessions page', () => {
    const sessionsItem = paletteItems.find((item) => item.id === 'workspace-sessions');

    expect(sessionsItem).toBeDefined();
    expect(sessionsItem!.href).toBe('/workspaces/{workspaceId}/sessions');
  });
});

describe('graduated capability entries are not shadowed by Customize', () => {
  // filteredNavItems (command-palette.tsx) preserves registry declaration
  // order rather than ranking by relevance, and 'workspace-customize' is declared
  // before 'workspace-skills'/'workspace-commands'/'workspace-connectors'. Before this fix,
  // Customize's keywords included the words "skills" and "commands", so it
  // matched — and listed ahead of — those two real entries. Observed live:
  // query "Skills" -> ["Customize", "Skills", ...].
  const customizeItem = paletteItems.find((item) => item.id === 'workspace-customize');
  const skillsItem = paletteItems.find((item) => item.id === 'workspace-skills');
  const commandsItem = paletteItems.find((item) => item.id === 'workspace-commands');
  const connectorsItem = paletteItems.find((item) => item.id === 'workspace-connectors');
  const policiesItem = paletteItems.find((item) => item.id === 'workspace-connectors-policies');

  test('typing "Skills" surfaces the real Skills entry; Customize no longer matches', () => {
    expect(skillsItem).toBeDefined();
    expect(matchesPaletteQuery(skillsItem!, 'Skills')).toBe(true);
    expect(matchesPaletteQuery(customizeItem!, 'Skills')).toBe(false);
  });

  test('typing "Commands" surfaces the real Commands entry; Customize no longer matches', () => {
    expect(commandsItem).toBeDefined();
    expect(matchesPaletteQuery(commandsItem!, 'Commands')).toBe(true);
    expect(matchesPaletteQuery(customizeItem!, 'Commands')).toBe(false);
  });

  test('typing "Connectors" still surfaces the Connectors entry', () => {
    expect(connectorsItem).toBeDefined();
    expect(matchesPaletteQuery(connectorsItem!, 'Connectors')).toBe(true);
    expect(matchesPaletteQuery(customizeItem!, 'Connectors')).toBe(false);
  });

  test('typing "agents" surfaces the real Agents entry; Customize no longer matches', () => {
    // Agents graduated to /projects/<id>/agent and carries its own palette
    // entry, so Customize dropped the word — exactly like skills and
    // connectors above. Leaving it would list Customize AHEAD of the page the
    // user is typing the name of.
    const agentsItem = paletteItems.find((item) => item.id === 'workspace-agents');
    expect(agentsItem).toBeDefined();
    expect(matchesPaletteQuery(agentsItem!, 'agents')).toBe(true);
    expect(matchesPaletteQuery(customizeItem!, 'agents')).toBe(false);
  });

  test('Connectors and Skills navigate to standalone pages; Commands opens Customize', () => {
    expect(skillsItem!.href).toBe('/workspaces/{workspaceId}/skills');
    expect(commandsItem!.href).toBe(
      '/workspaces/{workspaceId}/customize/commands',
    );
    expect(connectorsItem!.href).toBe('/workspaces/{workspaceId}/connectors');
  });

  test('workspace-connectors-policies no longer advertises a Customize destination it cannot reach', () => {
    expect(policiesItem).toBeDefined();
    expect(policiesItem!.href).toBe('/workspaces/{workspaceId}/connectors');
    expect(policiesItem!.label).not.toContain('Customize');
  });
});
