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
    // Build(2) + Connect(3) + Automate(2) + Manage(4) = 11 base items since
    // Commands and the standalone Runtime section were removed from Build
    // (this test pins only the base items, not the flag-gated extras).
    expect(totalBaseItems).toBe(11);
  });

  test('every Build item carries an icon and a human label', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    for (const item of build!.items) {
      expect(item.icon).toBeDefined();
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
