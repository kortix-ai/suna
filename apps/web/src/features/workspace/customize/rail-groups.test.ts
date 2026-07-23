import { describe, expect, test } from 'bun:test';

import { GROUPS } from './rail-groups';

describe('GROUPS — customize rail ordering', () => {
  test('Build is exactly Agents, Skills — the legacy Commands tab and the standalone Runtime section are gone', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    expect(build).toBeDefined();
    expect(build!.items.map((item) => item.section)).toEqual(['agents', 'skills']);
  });

  test('every base group keeps its full item set — count changes only with a deliberate rail restructure', () => {
    const totalBaseItems = GROUPS.reduce((sum, g) => sum + g.items.length, 0);
    // Build(2) + Connect(4) + Automate(2) + Manage(4) = 12 base items. Connect
    // grew to 4 when Models (the two-door connect surface) moved into the base
    // group so it's always in the nav, not only a composer deep-link;
    // `customize-panel.tsx` filters it out where the managed gateway is
    // unavailable (this test pins base items, not the flag-gated extras).
    expect(totalBaseItems).toBe(12);
  });

  test('Connect leads with Models, so the connect surface is reachable from the rail', () => {
    const connect = GROUPS.find((g) => g.label === 'Connect');
    expect(connect).toBeDefined();
    expect(connect!.items[0]!.section).toBe('llm-management');
    expect(connect!.items.map((item) => item.section)).toEqual([
      'llm-management',
      'connectors',
      'secrets',
      'channels',
    ]);
  });

  test('every Build item carries an icon and a human label', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    for (const item of build!.items) {
      expect(item.icon).toBeDefined();
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
