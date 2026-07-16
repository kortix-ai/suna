import { describe, expect, test } from 'bun:test';

import type { DependencyItem, ItemCapabilities } from '@/lib/marketplace-client';
import {
  emptyDescriptionCopy,
  emptyReadmeCopy,
  groupBundleMembersByType,
  groupCapabilities,
  itemCountLabel,
  resolveBundleMembers,
  totalCapabilityCount,
} from './marketplace-item-view';

describe('emptyDescriptionCopy', () => {
  test('derives type-aware wording for a skill', () => {
    expect(emptyDescriptionCopy('registry:skill')).toBe(
      "This skill doesn't have a description yet.",
    );
  });

  test('derives type-aware wording for an agent', () => {
    expect(emptyDescriptionCopy('registry:agent')).toBe(
      "This agent doesn't have a description yet.",
    );
  });

  test('derives type-aware wording for a bundle', () => {
    expect(emptyDescriptionCopy('registry:bundle')).toBe(
      "This bundle doesn't have a description yet.",
    );
  });

  test('falls back to the raw type label for an unknown type', () => {
    expect(emptyDescriptionCopy('registry:widget')).toBe(
      "This widget doesn't have a description yet.",
    );
  });
});

describe('emptyReadmeCopy', () => {
  test('derives type-aware wording for a command', () => {
    expect(emptyReadmeCopy('registry:command')).toBe("This command doesn't ship a README yet.");
  });

  test('derives type-aware wording for a skill', () => {
    expect(emptyReadmeCopy('registry:skill')).toBe("This skill doesn't ship a README yet.");
  });
});

describe('itemCountLabel', () => {
  test('a bundle counts its member dependencies as items', () => {
    const result = itemCountLabel({
      type: 'registry:bundle',
      dependencies: ['a', 'b', 'c'],
      fileCount: 0,
    });

    expect(result).toEqual({ count: 3, unit: 'items' });
  });

  test('a bundle with exactly one member uses the singular unit', () => {
    const result = itemCountLabel({ type: 'registry:bundle', dependencies: ['a'], fileCount: 0 });

    expect(result).toEqual({ count: 1, unit: 'item' });
  });

  test('a non-bundle type counts files, ignoring dependencies', () => {
    const result = itemCountLabel({ type: 'registry:skill', dependencies: ['a', 'b'], fileCount: 5 });

    expect(result).toEqual({ count: 5, unit: 'files' });
  });

  test('a single file uses the singular unit', () => {
    const result = itemCountLabel({ type: 'registry:agent', dependencies: [], fileCount: 1 });

    expect(result).toEqual({ count: 1, unit: 'file' });
  });
});

describe('resolveBundleMembers', () => {
  const hrefForId = (id: string) => `/marketplace/${id}`;

  test('joins each dependency name against its resolved metadata', () => {
    const dependencyItems: DependencyItem[] = [
      { id: 'kortix:review', name: 'review', type: 'registry:skill', title: 'Review', description: null },
    ];

    const members = resolveBundleMembers({
      dependencies: ['review'],
      dependencyItems,
      hrefForId,
    });

    expect(members).toEqual([
      {
        key: 'kortix:review',
        title: 'Review',
        type: 'registry:skill',
        description: null,
        href: '/marketplace/kortix:review',
      },
    ]);
  });

  test('preserves dependency order even when resolved metadata arrives in a different order', () => {
    const dependencyItems: DependencyItem[] = [
      { id: 'kortix:b', name: 'b', type: 'registry:skill', title: 'B', description: null },
      { id: 'kortix:a', name: 'a', type: 'registry:skill', title: 'A', description: null },
    ];

    const members = resolveBundleMembers({
      dependencies: ['a', 'b'],
      dependencyItems,
      hrefForId,
    });

    expect(members.map((m) => m.key)).toEqual(['kortix:a', 'kortix:b']);
  });

  test('falls back to the bare name when a dependency has no resolved metadata', () => {
    const members = resolveBundleMembers({
      dependencies: ['unresolved-item'],
      dependencyItems: [],
      hrefForId,
    });

    expect(members).toEqual([
      { key: 'unresolved-item', title: 'unresolved-item', type: null, description: null, href: null },
    ]);
  });

  test('an empty dependency list produces no members', () => {
    expect(resolveBundleMembers({ dependencies: [], dependencyItems: [], hrefForId })).toEqual([]);
  });
});

describe('groupBundleMembersByType', () => {
  const m = (key: string, type: string | null) => ({
    key,
    title: key,
    type,
    description: null,
    href: null,
  });

  test('buckets members by type in a stable order (skills, agents, tools, …)', () => {
    const groups = groupBundleMembersByType([
      m('t1', 'registry:tool'),
      m('s1', 'registry:skill'),
      m('a1', 'registry:agent'),
      m('s2', 'registry:skill'),
    ]);
    expect(groups.map((g) => [g.label, g.members.map((x) => x.key)])).toEqual([
      ['Skills', ['s1', 's2']],
      ['Agents', ['a1']],
      ['Tools', ['t1']],
    ]);
  });

  test('collects null/unrecognized types into an "Other" bucket at the end', () => {
    const groups = groupBundleMembersByType([
      m('s1', 'registry:skill'),
      m('x', null),
      m('y', 'registry:mystery'),
    ]);
    expect(groups[0].label).toBe('Skills');
    const other = groups[groups.length - 1];
    expect(other.label).toBe('Other');
    expect(other.members.map((x) => x.key).sort()).toEqual(['x', 'y']);
  });

  test('empty input produces no groups', () => {
    expect(groupBundleMembersByType([])).toEqual([]);
  });
});

describe('groupCapabilities', () => {
  function caps(overrides: Partial<ItemCapabilities>): ItemCapabilities {
    return { secrets: [], connectors: [], tools: [], network: [], ...overrides };
  }

  test('includes network alongside secrets, connectors, and tools', () => {
    const groups = groupCapabilities(
      caps({ secrets: ['API_KEY'], connectors: ['slack'], tools: ['search'], network: ['api.example.com'] }),
    );

    expect(groups).toEqual([
      { kind: 'secret', label: 'Secrets', items: ['API_KEY'] },
      { kind: 'connector', label: 'Connectors', items: ['slack'] },
      { kind: 'tool', label: 'Tools', items: ['search'] },
      { kind: 'network', label: 'Network', items: ['api.example.com'] },
    ]);
  });

  test('drops groups with no items', () => {
    const groups = groupCapabilities(caps({ secrets: ['API_KEY'] }));

    expect(groups).toEqual([{ kind: 'secret', label: 'Secrets', items: ['API_KEY'] }]);
  });

  test('an item with no capabilities produces no groups', () => {
    expect(groupCapabilities(caps({}))).toEqual([]);
  });

  test('null/undefined capabilities produce no groups', () => {
    expect(groupCapabilities(null)).toEqual([]);
    expect(groupCapabilities(undefined)).toEqual([]);
  });
});

describe('totalCapabilityCount', () => {
  test('sums every capability kind, including network', () => {
    const count = totalCapabilityCount({
      secrets: ['A', 'B'],
      connectors: ['c'],
      tools: [],
      network: ['n1', 'n2', 'n3'],
    });

    expect(count).toBe(6);
  });

  test('null/undefined capabilities count as zero', () => {
    expect(totalCapabilityCount(null)).toBe(0);
    expect(totalCapabilityCount(undefined)).toBe(0);
  });
});
