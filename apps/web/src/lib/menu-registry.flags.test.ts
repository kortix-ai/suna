import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURE_FLAG_KEYS } from '@kortix/sdk';
import { menuRegistry } from './menu-registry';

/**
 * `requiresFlag` is only a gate if EVERY consumer honours it. Before this, the
 * command palette filtered on it and `sidebar-right.tsx` did not — so the first
 * flagged item to gain `showIn: ['rightSidebar']` would have leaked a disabled
 * feature into the nav. These tests pin all three halves: the declaration, the
 * two consumers, and the flag map that resolves an arbitrary key.
 */
const root = resolve(import.meta.dir, '..');
const registrySource = readFileSync(join(root, 'lib/menu-registry.ts'), 'utf8');
const flagMapSource = readFileSync(join(root, 'lib/use-workspace-feature-flags.ts'), 'utf8');
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

  test('Review Center and Voice are reachable from the palette, behind their flags', () => {
    const review = menuRegistry.find((item) => item.id === 'workspace-review');
    const voice = menuRegistry.find((item) => item.id === 'workspace-voice');

    expect(review?.requiresFlag).toBe('review_center');
    expect(review?.href).toBe('/workspaces/{workspaceId}/customize/review');
    expect(voice?.requiresFlag).toBe('voice');
    expect(voice?.href).toBe('/workspaces/{workspaceId}/customize/voice');
    // Both must resolve to a real Customize section, or the palette opens the
    // overlay on nothing.
    const sections = readFileSync(join(root, 'lib/customize-sections.ts'), 'utf8');
    expect(sections).toContain("'review',");
    expect(sections).toContain("'voice',");
  });

  test('llm_gateway is gated on ENABLEMENT, not mere availability', () => {
    // The palette used to special-case this key onto `isLlmGatewayAvailable`
    // while the Customize panel rendered nothing unless it was enabled — an
    // entry that opened a blank pane.
    expect(paletteSource).not.toContain('isLlmGatewayAvailable');
    expect(paletteSource).toContain(
      'if (item.requiresFlag && !workspaceFlags[item.requiresFlag]) return false;',
    );
  });

  test('the right sidebar filters on requiresFlag too, fail-closed', () => {
    expect(sidebarSource).toContain('useWorkspaceFeatureFlags(routeWorkspaceId)');
    expect(sidebarSource).toContain(
      '(item: MenuItemDef) => !item.requiresFlag || featureFlags[item.requiresFlag]',
    );
    expect(sidebarSource).toContain('const quickActionClusters = filterClusters(');
    expect(sidebarSource).toContain('const navClusters = filterClusters(');
  });
});

describe('useWorkspaceFeatureFlags', () => {
  test('covers EVERY feature flag key, so a new flag is gateable on day one', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(flagMapSource).toContain(`useFeatureFlag(workspaceId, '${key}')`);
      expect(flagMapSource).toContain(`${key}: `);
    }
  });

  test('is composed from the ONE primitive, not a second hand-rolled read', () => {
    expect(flagMapSource).toContain("import { useFeatureFlag } from '@kortix/sdk/react';");
    expect(flagMapSource).not.toContain('useQuery');
    expect(flagMapSource).not.toContain('experimental');
  });
});
