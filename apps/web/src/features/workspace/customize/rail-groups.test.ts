import { describe, expect, test } from 'bun:test';

import { GROUPS } from './rail-groups';

describe('GROUPS — customize rail ordering (WS5-P5-a)', () => {
  test('the Build group leads with the ACP core, in order: Agents, Runtime, Skills, Commands', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    expect(build).toBeDefined();
    expect(build!.items.map((item) => item.section)).toEqual([
      'agents',
      'runtime',
      'skills',
      'commands',
    ]);
  });

  test('Runtime sits directly after Agents — not provisional, not displaced by a flag-gated item', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    const sections = build!.items.map((item) => item.section);
    const agentsIndex = sections.indexOf('agents');
    const runtimeIndex = sections.indexOf('runtime');
    expect(agentsIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBe(agentsIndex + 1);
  });

  test('every base group keeps its full item set — count changes only with a deliberate rail restructure', () => {
    const totalBaseItems = GROUPS.reduce((sum, g) => sum + g.items.length, 0);
    // Build(4) + Connect(3) + Automate(2) + Manage(4) = 13 base items since
    // the Git provider-first restructure dropped the Workspace group and
    // moved Git + Sandbox templates into Manage (this test pins only the
    // base items, not the flag-gated extras).
    expect(totalBaseItems).toBe(13);
  });

  test('every Build item carries an icon and a human label', () => {
    const build = GROUPS.find((g) => g.label === 'Build');
    for (const item of build!.items) {
      expect(item.icon).toBeDefined();
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
