import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import type { DependencyItem, ItemCapabilities, MarketplaceItemDetail } from '@/lib/marketplace-client';
import {
  emptyDescriptionCopy,
  emptyReadmeCopy,
  groupCapabilities,
  marketplaceFileNodes,
  resolveBundleMembers,
  projectContentGroups,
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

describe('resolveBundleMembers', () => {
  const hrefForId = (id: string) => `/marketplace/${id}`;

  test('joins each dependency name against its resolved metadata', () => {
    const dependencyItems: DependencyItem[] = [
      {
        id: 'kortix:review',
        name: 'review',
        type: 'registry:skill',
        title: 'Review',
        description: null,
      },
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
      {
        key: 'unresolved-item',
        title: 'unresolved-item',
        type: null,
        description: null,
        href: null,
      },
    ]);
  });

  test('an empty dependency list produces no members', () => {
    expect(resolveBundleMembers({ dependencies: [], dependencyItems: [], hrefForId })).toEqual([]);
  });
});

describe('groupCapabilities', () => {
  function caps(overrides: Partial<ItemCapabilities>): ItemCapabilities {
    return { secrets: [], connectors: [], tools: [], network: [], ...overrides };
  }

  test('includes network alongside secrets, connectors, and tools', () => {
    const groups = groupCapabilities(
      caps({
        secrets: ['API_KEY'],
        connectors: ['slack'],
        tools: ['search'],
        network: ['api.example.com'],
      }),
      testUiTranslator,
    );

    expect(groups).toEqual([
      { kind: 'secret', label: 'Secrets', items: ['API_KEY'] },
      { kind: 'connector', label: 'Connectors', items: ['slack'] },
      { kind: 'tool', label: 'Tools', items: ['search'] },
      { kind: 'network', label: 'Network', items: ['api.example.com'] },
    ]);
  });

  test('drops groups with no items', () => {
    const groups = groupCapabilities(caps({ secrets: ['API_KEY'] }), testUiTranslator);

    expect(groups).toEqual([{ kind: 'secret', label: 'Secrets', items: ['API_KEY'] }]);
  });

  test('an item with no capabilities produces no groups', () => {
    expect(groupCapabilities(caps({}), testUiTranslator)).toEqual([]);
  });

  test('null/undefined capabilities produce no groups', () => {
    expect(groupCapabilities(null, testUiTranslator)).toEqual([]);
    expect(groupCapabilities(undefined, testUiTranslator)).toEqual([]);
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

describe('marketplaceFileNodes', () => {
  test('roots the tree at the shared skill directory, SKILL.md first', () => {
    const nodes = marketplaceFileNodes([
      '@skills/pdf/scripts/fill.py',
      '@skills/pdf/SKILL.md',
      '@skills/pdf/reference.md',
    ]);
    expect(nodes).toEqual([
      { path: '@skills/pdf/SKILL.md', name: 'SKILL.md', depth: 0 },
      { path: '@skills/pdf/reference.md', name: 'reference.md', depth: 0 },
      { path: '@skills/pdf/scripts/fill.py', name: 'fill.py', depth: 1 },
    ]);
  });

  test('a single file is one root row', () => {
    expect(marketplaceFileNodes(['@skills/docx/SKILL.md'])).toEqual([
      { path: '@skills/docx/SKILL.md', name: 'SKILL.md', depth: 0 },
    ]);
  });

  test('targets with no shared directory keep every file, listed flat', () => {
    expect(marketplaceFileNodes(['b/two.md', 'a/one.md']).map((n) => n.path)).toEqual([
      'a/one.md',
      'b/two.md',
    ]);
  });

  test('no targets, no rows', () => {
    expect(marketplaceFileNodes([])).toEqual([]);
  });
});

describe('projectContentGroups', () => {
  const data: MarketplaceItemDetail = {
    id: 'synthetic:project', registry: 'synthetic', name: 'project', type: 'registry:project',
    title: 'Project', description: null, categories: [],
    capabilities: { secrets: [], connectors: [], tools: [], network: [] },
    dependencies: ['second', 'missing', 'first'], fileCount: 2, external: true,
    marketplaceId: 'synthetic-source', marketplaceLabel: 'Synthetic source',
    owner: 'synthetic-owner', sourceUrl: 'https://example.test/source', files: [], readme: null,
    dependencyItems: [
      { id: 'synthetic:first', name: 'first', type: 'registry:skill', title: 'First-title', description: null },
      { id: 'synthetic:second', name: 'second', type: 'registry:skill', title: 'Second', description: 'Description' },
    ],
    projectAgents: [{ name: 'review-agent', title: 'Review-agent', description: null }],
    projectTriggers: [{ slug: 'daily-check', description: 'Trigger', agent: 'review-agent' }],
  };

  test('preserves order, filters unresolved dependencies, and assigns navigability and labels', () => {
    const groups = projectContentGroups(data, testUiTranslator);
    expect(groups.map((g) => [g.label, g.navigable, g.items.map((it) => it.id)])).toEqual([
      ['Skills', true, ['synthetic:second', 'synthetic:first']],
      ['Agents', false, ['agent:review-agent']],
      ['Triggers', false, ['trigger:daily-check']],
    ]);
    expect(groups.flatMap((g) => g.items.map((it) => [it.name, it.title, it.description]))).toEqual([
      ['second', 'Second', 'Description'], ['first', 'First-title', null],
      ['review-agent', 'Review agent', null], ['daily-check', 'daily check', 'Trigger'],
    ]);
    for (const item of groups.flatMap((g) => g.items)) {
      expect(item.registry).toBe(data.registry);
      expect(item.external).toBe(true);
      expect(item.marketplaceId).toBe(data.marketplaceId);
      expect(item.marketplaceLabel).toBe(data.marketplaceLabel);
      expect(item.owner).toBe(data.owner);
      expect(item.sourceUrl).toBe(data.sourceUrl);
      expect(item.categories).toEqual([]);
      expect(item.capabilities).toEqual({ secrets: [], connectors: [], tools: [], network: [] });
      expect(item.dependencies).toEqual([]);
      expect(item.fileCount).toBe(0);
    }
  });

  test('non-projects and empty projects have no card groups', () => {
    expect(projectContentGroups({ ...data, type: 'registry:bundle' }, testUiTranslator)).toEqual([]);
    expect(projectContentGroups({ ...data, dependencies: [], projectAgents: [], projectTriggers: [] }, testUiTranslator)).toEqual([]);
  });
});
