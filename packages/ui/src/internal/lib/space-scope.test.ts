import { describe, expect, test } from 'bun:test';

import { PROJECT_WIDE_SPACE } from '@kortix/sdk';

import { SPACES_FLAG, spaceScope } from './space-scope';

const config = {
  agents: [{ name: 'closer', space: 'sales' }, { name: 'writer' }],
  spaces: [{ name: 'sales', label: 'Sales' }],
};
const items = [
  { id: 'bound', space: 'sales' },
  { id: 'via-agent', agent: 'closer' },
  { id: 'loose' },
];

describe('spaceScope', () => {
  test('spaces are gated by the project_channels flag', () => {
    expect(SPACES_FLAG).toBe('project_channels');
  });

  test('flag off: no spaces to offer, every item is project-wide', () => {
    const scope = spaceScope(items, config, false, (item) => item);
    // No spaces: the filter tabs render nothing and the card has no "Move to space".
    expect(scope.spaces).toEqual([]);
    expect(items.map(scope.spaceOf)).toEqual([PROJECT_WIDE_SPACE, PROJECT_WIDE_SPACE, PROJECT_WIDE_SPACE]);
    expect(scope.groups.map((group) => group.name)).toEqual([PROJECT_WIDE_SPACE]);
  });

  test('flag on: the declared spaces, and each item in its bound or its agent space', () => {
    const scope = spaceScope(items, config, true, (item) => item);
    expect(scope.spaces.map((space) => space.name)).toEqual(['sales']);
    expect(items.map(scope.spaceOf)).toEqual(['sales', 'sales', PROJECT_WIDE_SPACE]);
    expect(scope.groups.map((group) => [group.name, group.items.length])).toEqual([
      ['sales', 2],
      [PROJECT_WIDE_SPACE, 1],
    ]);
  });
});
