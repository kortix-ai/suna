import { describe, expect, test } from 'bun:test';

import {
  agentsInSpace,
  bindingSpace,
  DEFAULT_SPACE_HEADER,
  DEFAULT_SPACE_TABS,
  groupBySpace,
  listSpaces,
  PROJECT_WIDE_SPACE,
  type ProjectSpace,
  spaceHeader,
  spaceTabKey,
  spaceTabs,
} from './spaces.ts';

const declared: ProjectSpace[] = [
  { name: 'marketing', label: 'Marketing', order: 2 },
  { name: 'engineering', label: 'Engineering', order: 1 },
];

const team = [
  { name: 'builder', space: 'engineering' },
  { name: 'writer', space: 'marketing' },
  { name: 'helper' },
];

describe('groupBySpace', () => {
  test('groups by `space` by default: declared by order, then undeclared, then Project-wide last', () => {
    const agents = [...team, { name: 'scout', space: 'security' }, { name: 'refactorer', space: 'engineering' }];
    const groups = groupBySpace(agents, declared);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.name)])).toEqual([
      ['engineering', ['builder', 'refactorer']],
      ['marketing', ['writer']],
      ['security', ['scout']],
      [PROJECT_WIDE_SPACE, ['helper']],
    ]);
    expect(groups[0]).toMatchObject({ label: 'Engineering', isDefault: false });
    expect(groups[2]?.label).toBe('security');
    expect(groups.at(-1)).toMatchObject({ label: 'Project-wide', isDefault: true });
  });

  test('a blank space folds into Project-wide, and an empty declared space is omitted', () => {
    const groups = groupBySpace([{ name: 'x', space: '  ' }, { name: 'y', space: null }], declared);
    expect(groups.map((g) => g.name)).toEqual([PROJECT_WIDE_SPACE]);
  });

  test('takes an accessor, so any resource groups through bindingSpace', () => {
    const goals = [
      { slug: 'g1', goal: { agent: 'builder' } },
      { slug: 'g2', goal: null },
    ];
    const groups = groupBySpace(goals, declared, (g) => bindingSpace(g.goal, team));
    expect(groups.map((g) => [g.name, g.items.map((i) => i.slug)])).toEqual([
      ['engineering', ['g1']],
      [PROJECT_WIDE_SPACE, ['g2']],
    ]);
  });

  test('a space named `general` is a real space, not the Project-wide bucket', () => {
    const groups = groupBySpace([{ name: 'a', space: 'general' }, { name: 'b' }], [{ name: 'general', label: 'General' }]);
    expect(groups.map((g) => [g.name, g.isDefault])).toEqual([
      ['general', false],
      [PROJECT_WIDE_SPACE, true],
    ]);
  });
});

describe('bindings and listing', () => {
  test('bindingSpace: an explicit space wins, else the agent space, else project-wide (null)', () => {
    expect(bindingSpace({ space: 'ops', agent: 'builder' }, team)).toBe('ops');
    expect(bindingSpace({ agent: 'builder' }, team)).toBe('engineering');
    expect(bindingSpace({ agent: 'helper' }, team)).toBeNull();
    expect(bindingSpace({ agent: 'unknown' }, team)).toBeNull();
    expect(bindingSpace({ space: '  ', agent: null }, team)).toBeNull();
    expect(bindingSpace(null, team)).toBeNull();
  });

  test('agentsInSpace lists the agents whose space is the slug', () => {
    expect(agentsInSpace('engineering', [...team, { name: 'refactorer', space: 'engineering' }])).toEqual([
      'builder',
      'refactorer',
    ]);
    expect(agentsInSpace('ops', team)).toEqual([]);
  });

  test('listSpaces: declared spaces even with no agents, then referenced ones', () => {
    const spaces = listSpaces({
      agents: [{ name: 'scout', space: 'security' }, { name: 'helper' }, { name: 'builder', space: 'engineering' }],
      spaces: [...declared, { name: 'ops', label: 'Ops', order: 3 }, { name: 'general' }],
    });
    expect(spaces.map((s) => s.name)).toEqual(['engineering', 'marketing', 'ops', 'general', 'security']);
    expect(spaces.find((s) => s.name === 'security')).toEqual({ name: 'security' });
    expect(listSpaces({ agents: [] })).toEqual([]);
    expect(listSpaces(null)).toEqual([]);
  });
});

describe('tabs and header', () => {
  test('a space with no tabs gets the default views', () => {
    expect(spaceTabs({ name: 'eng' })).toEqual(DEFAULT_SPACE_TABS);
    expect(DEFAULT_SPACE_TABS.map((t) => t.type)).toEqual(['goals', 'apps', 'artifacts']);
  });

  test('configured tabs replace the defaults, an empty list included', () => {
    const tabs = [{ type: 'link' as const, url: 'https://example.com' }];
    expect(spaceTabs({ name: 'eng', tabs })).toEqual(tabs);
    expect(spaceTabs({ name: 'eng', tabs: [] })).toEqual([]);
  });

  test('spaceTabKey: views by type, pinned items by target, the rest by position', () => {
    expect(spaceTabKey({ type: 'goals' }, 4)).toBe('goals');
    expect(spaceTabKey({ type: 'app', app: 'crm' }, 1)).toBe('app-crm');
    expect(spaceTabKey({ type: 'artifact', artifact: 'a1' }, 1)).toBe('artifact-a1');
    expect(spaceTabKey({ type: 'board' }, 2)).toBe('board-2');
    expect(spaceTabKey({ type: 'link', url: 'https://x.test' }, 3)).toBe('link-3');
    expect(spaceTabKey({ type: 'files', path: 'docs' }, 0)).toBe('files-0');
  });

  test('spaceHeader: every item by default, else the configured list', () => {
    expect(spaceHeader({ name: 'eng' })).toEqual(DEFAULT_SPACE_HEADER);
    expect(spaceHeader({ name: 'eng', header: ['agents'] })).toEqual(['agents']);
  });
});
