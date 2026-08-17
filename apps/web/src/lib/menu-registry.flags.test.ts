import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURE_FLAG_KEYS } from '@kortix/sdk';
import { settingsPaletteGroups } from '@/features/workspace/settings-palette-items';
import type { RailFlags } from '@/features/workspace/settings/rail';
import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { menuRegistry } from './menu-registry';

const ALL_FLAGS_OFF: RailFlags = {
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
};

/**
 * `requiresFlag` is only a gate if EVERY consumer honours it. Before this, the
 * command palette filtered on it and `sidebar-right.tsx` did not — so the first
 * flagged item to gain `showIn: ['rightSidebar']` would have leaked a disabled
 * feature into the nav. These tests pin all three halves: the declaration, the
 * two consumers, and the flag map that resolves an arbitrary key.
 */
const root = resolve(import.meta.dir, '..');
const registrySource = readFileSync(join(root, 'lib/menu-registry.ts'), 'utf8');
const flagMapSource = readFileSync(join(root, 'lib/use-project-feature-flags.ts'), 'utf8');
const paletteSource = readFileSync(
  join(root, 'features/workspace/command-palette.tsx'),
  'utf8',
);
const sidebarSource = readFileSync(join(root, 'components/sidebar/sidebar-right.tsx'), 'utf8');

describe('menu registry feature-flag gating', () => {
  test('the field is named requiresFlag and typed FeatureFlagKey', () => {
    expect(registrySource).toContain('requiresFlag?: FeatureFlagKey;');
    expect(registrySource).toContain("import type { FeatureFlagKey } from '@kortix/sdk';");
    expect(registrySource).not.toContain('requiresExperimental');
    expect(registrySource).not.toContain('ExperimentalFeatureKey');
  });

  test('every declared requiresFlag value is a real feature flag key', () => {
    const declared = menuRegistry.flatMap((item) => (item.requiresFlag ? [item.requiresFlag] : []));
    expect(declared.length).toBeGreaterThan(0);
    for (const key of declared) {
      expect(FEATURE_FLAG_KEYS).toContain(key);
    }
  });

  test('Review Center, Voice and Marketplace are reachable from the palette, behind their flags', () => {
    // These were `proj-review` / `proj-voice` / `proj-marketplace` registry
    // entries carrying their own `requiresFlag`. Both halves — "reachable"
    // and "behind the flag" — now come from `railGroups`, so this asserts the
    // BEHAVIOUR rather than the removed declarations. Same contract, one
    // source: a flag that hides the rail row hides the palette row.
    const tabsFor = (flags: RailFlags) =>
      settingsPaletteGroups({ hasProject: true, flags, billingEnabled: true }).flatMap((group) =>
        group.items.map((item) => item.tab),
      );

    const off = tabsFor(ALL_FLAGS_OFF);
    expect(off).not.toContain('review');
    expect(off).not.toContain('voice');
    expect(off).not.toContain('marketplace');

    expect(tabsFor({ ...ALL_FLAGS_OFF, reviewEnabled: true })).toContain('review');
    expect(tabsFor({ ...ALL_FLAGS_OFF, voiceEnabled: true })).toContain('voice');
    expect(tabsFor({ ...ALL_FLAGS_OFF, marketplaceEnabled: true })).toContain('marketplace');

    // All three must be real settings tabs, or the palette opens the overlay
    // on nothing.
    expect(parseSettingsTab('review')).toBe('review');
    expect(parseSettingsTab('voice')).toBe('voice');
    expect(parseSettingsTab('marketplace')).toBe('marketplace');
  });

  test('the Models row is NOT gated on llm_gateway, in either vocabulary', () => {
    // Two separate bugs met here. `proj-llm` declared
    // `requiresFlag: 'llm_gateway'`, so the palette hid Models for every
    // project without the gateway — while `rail.ts` documents that the rail
    // shows Models unconditionally (`llmGatewayAvailable` only controls the
    // `llm-*` sub-sections INSIDE the tab). Deriving from the rail settles
    // it; these two assertions stop either half coming back.
    const withGatewayOff = settingsPaletteGroups({
      hasProject: true,
      flags: ALL_FLAGS_OFF,
      billingEnabled: true,
    }).flatMap((group) => group.items.map((item) => item.tab));
    expect(withGatewayOff).toContain('models');

    expect(menuRegistry.filter((item) => item.requiresFlag === 'llm_gateway')).toEqual([]);
  });

  test('the palette honours requiresFlag for the entries that still declare one', () => {
    // `proj-apps` is the only remaining flagged palette entry. The filter
    // line is the whole gate, so it is pinned literally — a rename or a
    // fail-OPEN rewrite of it would otherwise pass every other test here.
    const flagged = menuRegistry.filter(
      (item) => item.requiresFlag && item.showIn.includes('commandPalette'),
    );
    expect(flagged.map((item) => item.id)).toContain('proj-apps');
    expect(paletteSource).toContain(
      'if (item.requiresFlag && !projectFlags[item.requiresFlag]) continue;',
    );
  });

  test('the right sidebar filters on requiresFlag too, fail-closed', () => {
    expect(sidebarSource).toContain('useProjectFeatureFlags(routeProjectId)');
    expect(sidebarSource).toContain(
      '(item: MenuItemDef) => !item.requiresFlag || featureFlags[item.requiresFlag]',
    );
    expect(sidebarSource).toContain('const quickActionClusters = filterClusters(');
    expect(sidebarSource).toContain('const navClusters = filterClusters(');
  });
});

describe('useProjectFeatureFlags', () => {
  test('covers EVERY feature flag key, so a new flag is gateable on day one', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(flagMapSource).toContain(`useFeatureFlag(projectId, '${key}')`);
      expect(flagMapSource).toContain(`${key}: `);
    }
  });

  test('is composed from the ONE primitive, not a second hand-rolled read', () => {
    expect(flagMapSource).toContain("import { useFeatureFlag } from '@kortix/sdk/react';");
    expect(flagMapSource).not.toContain('useQuery');
    expect(flagMapSource).not.toContain('experimental');
  });
});
