import { describe, expect, test } from 'bun:test';

import { DEFAULT_PROJECT_DOMAIN, groupByDomain, type ProjectDomain } from './domains.ts';

type Item = { name: string; domain?: string | null };

const agents: Item[] = [
  { name: 'builder', domain: 'engineering' },
  { name: 'writer', domain: 'marketing' },
  { name: 'helper' }, // no domain → default bucket
  { name: 'refactorer', domain: 'engineering' },
  { name: 'scout', domain: 'security' }, // referenced but not declared
];

const declared: ProjectDomain[] = [
  { name: 'marketing', label: 'Marketing', order: 2 },
  { name: 'engineering', label: 'Engineering', order: 1 },
];

describe('groupByDomain', () => {
  test('groups items by their domain', () => {
    const groups = groupByDomain(agents, declared);
    const byName = Object.fromEntries(groups.map((g) => [g.name, g.items.map((i) => i.name)]));
    expect(byName.engineering).toEqual(['builder', 'refactorer']);
    expect(byName.marketing).toEqual(['writer']);
    expect(byName.security).toEqual(['scout']);
    expect(byName[DEFAULT_PROJECT_DOMAIN]).toEqual(['helper']);
  });

  test('orders declared domains by `order`, then undeclared alpha, then the default bucket last', () => {
    const order = groupByDomain(agents, declared).map((g) => g.name);
    expect(order).toEqual(['engineering', 'marketing', 'security', DEFAULT_PROJECT_DOMAIN]);
  });

  test('uses the declared label; falls back to the slug for an undeclared domain', () => {
    const groups = groupByDomain(agents, declared);
    expect(groups.find((g) => g.name === 'engineering')?.label).toBe('Engineering');
    expect(groups.find((g) => g.name === 'security')?.label).toBe('security');
  });

  test('marks the default bucket', () => {
    const groups = groupByDomain(agents, declared);
    expect(groups.find((g) => g.name === DEFAULT_PROJECT_DOMAIN)?.isDefault).toBe(true);
    expect(groups.find((g) => g.name === 'engineering')?.isDefault).toBe(false);
  });

  test('backward compatible: no domains at all → one default group with every item', () => {
    const flat: Item[] = [{ name: 'a' }, { name: 'b' }];
    const groups = groupByDomain(flat);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe(DEFAULT_PROJECT_DOMAIN);
    expect(groups[0].items.map((i) => i.name)).toEqual(['a', 'b']);
  });

  test('a blank or whitespace domain folds into the default bucket', () => {
    const groups = groupByDomain([{ name: 'x', domain: '  ' }, { name: 'y', domain: null }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe(DEFAULT_PROJECT_DOMAIN);
  });

  test('omits a declared domain that has no items', () => {
    const groups = groupByDomain([{ name: 'only', domain: 'engineering' }], declared);
    expect(groups.map((g) => g.name)).toEqual(['engineering']);
  });
});
