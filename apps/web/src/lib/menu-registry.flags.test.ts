import { CAPABILITY_TABS } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { visibleCapabilityTabs } from '@/features/workspace/capabilities/shared/capability-tabs';
import { settingsPaletteGroups } from '@/features/workspace/settings-palette-items';
import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { menuRegistry } from './menu-registry';

/**
 * Every flag a capability tab gates itself on, all off. Written out rather
 * than left as `{}` — both read as off (the gate is fail-closed), but an
 * explicit `false` is the state a project is actually in, and a new gated tab
 * then shows up as a missing key here instead of passing silently.
 */
const ALL_FLAGS_OFF: Partial<Record<FeatureFlagKey, boolean>> = {
  review_center: false,
  marketplace: false,
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
const paletteSource = readFileSync(join(root, 'features/workspace/command-palette.tsx'), 'utf8');
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

  test('Review Center is reachable behind its flag and removed features stay absent', () => {
    // Review is a capability tab since 2026-09-02, gated by the bar itself
    // (`visibleCapabilityTabs`), so this asserts the BEHAVIOUR rather than a
    // declaration — a flag that hides the tab hides every way in. Voice has no
    // flag any more: it was removed from the product. Marketplace is a
    // capability tab on the `marketplace` flag, so it must answer to its OWN
    // flag and stay hidden while only `review_center` is on.
    const keysFor = (flags: Partial<Record<FeatureFlagKey, boolean>>) =>
      visibleCapabilityTabs({}, flags).map((tab) => tab.key);

    const off = keysFor(ALL_FLAGS_OFF);
    expect(off).not.toContain('review');
    expect(off).not.toContain('voice');
    expect(off).not.toContain('marketplace');

    expect(keysFor({ ...ALL_FLAGS_OFF, review_center: true })).toContain('review');
    expect(keysFor({ ...ALL_FLAGS_OFF, review_center: true })).not.toContain('marketplace');
    expect(keysFor({ ...ALL_FLAGS_OFF, marketplace: true })).toContain('marketplace');

    // None of them is a settings tab any more, so the derived palette list
    // must not offer one — that would open the overlay on nothing.
    const paletteTabs = settingsPaletteGroups({ hasProject: true }).flatMap((group) =>
      group.items.map((item) => item.tab as string),
    );
    for (const key of ['review', 'voice', 'marketplace']) {
      expect(paletteTabs).not.toContain(key);
    }
  });

  test('the Models tab is NOT gated on llm_gateway', () => {
    // Two separate bugs met here, historically. `proj-llm` declared
    // `requiresFlag: 'llm_gateway'`, so the palette hid Models for every
    // project without the gateway — while the rail showed Models
    // unconditionally (availability only controls the `llm-*` sub-sections
    // INSIDE the pane, via `llmGatewayEnabled` — see `models-tab.tsx`). Models
    // has since graduated a second time, off `/config` and onto its own
    // top-level Customize tab (`capability-tab-routes.ts`), but the same rule
    // holds: no flag reaches it.
    expect(CAPABILITY_TABS.map((t) => t.key)).toContain('models');

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
