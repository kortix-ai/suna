import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SETTINGS_TABS, legacySectionRedirect, parseSettingsTab } from './settings-tabs';

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

/**
 * Every route that names a pane delegates to ONE component, `PanelDeepLink` —
 * these routes cannot be rendered here (no DOM harness; each body is a single
 * effect), so this scans their sources, the idiom `general-tab.rename.test.tsx`
 * uses.
 *
 * What it pins: no route may hand-roll its own resolution. `PanelDeepLink` is
 * where "a tab opens on the surface that owns it" lives, and a route that
 * bypassed it would strand a bookmark on a rail that no longer lists its tab.
 */
describe('every pane route delegates to PanelDeepLink', () => {
  const routes: Record<string, string> = {
    'settings/[tab]': 'app/(app)/projects/[id]/settings/[tab]/page.tsx',
    settings: 'app/(app)/projects/[id]/settings/page.tsx',
    'customize/[section]': 'app/(app)/projects/[id]/customize/[section]/page.tsx',
    customize: 'app/(app)/projects/[id]/customize/page.tsx',
    agent: 'app/(app)/projects/[id]/agent/page.tsx',
    skills: 'app/(app)/projects/[id]/skills/page.tsx',
    connectors: 'app/(app)/projects/[id]/connectors/page.tsx',
    apps: 'app/(app)/projects/[id]/apps/page.tsx',
  };

  for (const [name, path] of Object.entries(routes)) {
    test(`${name} renders PanelDeepLink and nothing else`, () => {
      const source = readFileSync(resolve(import.meta.dir, '../../../', path), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).toContain('<PanelDeepLink');
      expect(code).not.toContain('useSettingsPanelStore');
      expect(code).not.toContain('legacySectionRedirect');
    });
  }

  test('the four capability routes name their pane, so a bookmark keeps its place', () => {
    const paneOf = (path: string) =>
      readFileSync(resolve(import.meta.dir, '../../../', path), 'utf8').match(
        /segment="([a-z-]+)"/,
      )?.[1];
    expect(paneOf(routes.agent)).toBe('agents');
    expect(paneOf(routes.skills)).toBe('skills');
    expect(paneOf(routes.connectors)).toBe('connectors');
    expect(paneOf(routes.apps)).toBe('apps');
  });

  test('the resolution it delegates to sends computers to the Connectors pane', () => {
    expect(parseSettingsTab('computers')).toBeNull();
    expect(legacySectionRedirect('p1', 'computers')).toBe('/projects/p1/customize/connectors');
  });

  test('a genuinely unknown segment still has nowhere to go but the default tab', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });
});
