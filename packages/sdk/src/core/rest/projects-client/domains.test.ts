import { describe, expect, test } from 'bun:test';

import {
  agentsInSpace,
  bindingSpace,
  DEFAULT_PROJECT_DOMAIN,
  groupByDomain,
  groupBySpace,
  listSpaces,
  type ProjectDomain,
} from './domains.ts';

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

describe('spaces: bindings and listing', () => {
  const team = [
    { name: 'builder', domain: 'engineering' },
    { name: 'writer', domain: 'marketing' },
    { name: 'helper' },
  ];

  test('bindingSpace: an explicit space wins, else the agent space, else project-wide (null)', () => {
    expect(bindingSpace({ space: 'ops', agent: 'builder' }, team)).toBe('ops');
    expect(bindingSpace({ agent: 'builder' }, team)).toBe('engineering');
    expect(bindingSpace({ agent: 'helper' }, team)).toBeNull();
    expect(bindingSpace({ agent: 'unknown' }, team)).toBeNull();
    expect(bindingSpace({ space: '  ', agent: null }, team)).toBeNull();
    expect(bindingSpace(null, team)).toBeNull();
    expect(bindingSpace(undefined, team)).toBeNull();
  });

  test('agentsInSpace lists the agents whose domain is the slug', () => {
    expect(agentsInSpace('engineering', [...team, { name: 'refactorer', domain: 'engineering' }])).toEqual([
      'builder',
      'refactorer',
    ]);
    expect(agentsInSpace('ops', team)).toEqual([]);
  });

  test('groupBySpace: declared spaces first, then undeclared, then Project-wide last', () => {
    const items = [
      { id: 'a', space: 'marketing' },
      { id: 'b', space: null },
      { id: 'c', space: 'security' },
      { id: 'd', space: 'engineering' },
    ];
    const groups = groupBySpace(items, declared);
    expect(groups.map((g) => g.name)).toEqual(['engineering', 'marketing', 'security', DEFAULT_PROJECT_DOMAIN]);
    expect(groups.at(-1)).toMatchObject({ label: 'Project-wide', isDefault: true, items: [{ id: 'b' }] });
    expect(groups[0]).toMatchObject({ label: 'Engineering', items: [{ id: 'd' }] });
  });

  test('groupBySpace takes an accessor, so any resource shape groups through bindingSpace', () => {
    const goals = [
      { slug: 'g1', goal: { agent: 'builder' } },
      { slug: 'g2', goal: null },
    ];
    const groups = groupBySpace(goals, declared, (g) => bindingSpace(g.goal, team));
    expect(groups.map((g) => [g.name, g.items.map((i) => i.slug)])).toEqual([
      ['engineering', ['g1']],
      [DEFAULT_PROJECT_DOMAIN, ['g2']],
    ]);
  });

  test('listSpaces: declared spaces even with no agents, then referenced ones, never the default', () => {
    const spaces = listSpaces({
      agents: [{ name: 'scout', domain: 'security' }, { name: 'helper' }, { name: 'builder', domain: 'engineering' }],
      domains: [...declared, { name: 'ops', label: 'Ops', order: 3 }],
    });
    expect(spaces.map((s) => s.name)).toEqual(['engineering', 'marketing', 'ops', 'security']);
    expect(spaces.find((s) => s.name === 'security')).toEqual({ name: 'security' });
    expect(listSpaces({ agents: [] })).toEqual([]);
    expect(listSpaces(null)).toEqual([]);
  });
});
