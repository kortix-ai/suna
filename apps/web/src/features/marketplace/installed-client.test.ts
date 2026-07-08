import { describe, expect, test } from 'bun:test';

import type { InstalledItem, MarketplaceItem, RegistryItemStatus } from '@/lib/marketplace-client';
import {
  buildCatalogByName,
  deriveInstalledItemStatus,
  describeRemoveConsequence,
  filterInstalledItems,
  matchesInstalledItemQuery,
  updatableInstalledItemNames,
} from './installed-client';

function makeItem(overrides: Partial<InstalledItem> = {}): InstalledItem {
  return {
    name: 'pdf-toolkit',
    type: 'registry:skill',
    source: 'kortix/marketplace',
    installed_at: '2026-07-01T00:00:00.000Z',
    file_count: 3,
    ...overrides,
  };
}

describe('deriveInstalledItemStatus', () => {
  test('reports the status from the updates map when present', () => {
    const map = new Map<string, RegistryItemStatus>([['pdf-toolkit', 'update-available']]);

    expect(deriveInstalledItemStatus('pdf-toolkit', map)).toBe('update-available');
  });

  test('reports orphaned when the map says orphaned', () => {
    const map = new Map<string, RegistryItemStatus>([['pdf-toolkit', 'orphaned']]);

    expect(deriveInstalledItemStatus('pdf-toolkit', map)).toBe('orphaned');
  });

  test('falls back to up-to-date when absent from the map (server only lists attention items)', () => {
    const map = new Map<string, RegistryItemStatus>();

    expect(deriveInstalledItemStatus('pdf-toolkit', map)).toBe('up-to-date');
  });
});

describe('matchesInstalledItemQuery', () => {
  test('an empty query matches everything', () => {
    expect(matchesInstalledItemQuery(makeItem(), '')).toBe(true);
    expect(matchesInstalledItemQuery(makeItem(), '   ')).toBe(true);
  });

  test('matches on the raw registry name, case-insensitively', () => {
    expect(matchesInstalledItemQuery(makeItem({ name: 'PDF-Toolkit' }), 'pdf')).toBe(true);
  });

  test('matches on the resolved catalog title even when the name differs', () => {
    const item = makeItem({ name: 'internal-slug-42' });

    expect(matchesInstalledItemQuery(item, 'notion', { catalogTitle: 'Notion Sync' })).toBe(true);
  });

  test('matches on the source', () => {
    expect(matchesInstalledItemQuery(makeItem({ source: 'acme/tools' }), 'acme')).toBe(true);
  });

  test('matches on the type label', () => {
    expect(matchesInstalledItemQuery(makeItem(), 'skill', { typeLabel: 'Skill' })).toBe(true);
  });

  test('does not match unrelated text', () => {
    expect(matchesInstalledItemQuery(makeItem(), 'zzz-nope')).toBe(false);
  });
});

describe('filterInstalledItems', () => {
  const items = [
    makeItem({ name: 'pdf-toolkit' }),
    makeItem({ name: 'notion-sync', source: 'acme/tools' }),
  ];
  const resolve = () => ({});

  test('an empty query returns every item unfiltered', () => {
    expect(filterInstalledItems(items, '', resolve)).toEqual(items);
  });

  test('filters down to items matching the query', () => {
    const result = filterInstalledItems(items, 'notion', resolve);

    expect(result.map((i) => i.name)).toEqual(['notion-sync']);
  });

  test('resolves catalog title per item so titles (not just names) are searchable', () => {
    const resolveByName = (item: InstalledItem) =>
      item.name === 'pdf-toolkit' ? { catalogTitle: 'PDF Toolkit Pro' } : {};

    const result = filterInstalledItems(items, 'toolkit pro', resolveByName);

    expect(result.map((i) => i.name)).toEqual(['pdf-toolkit']);
  });

  test('no matches returns an empty list', () => {
    expect(filterInstalledItems(items, 'nothing-matches-this', resolve)).toEqual([]);
  });
});

describe('describeRemoveConsequence', () => {
  test('names the file count and that it commits the removal', () => {
    const sentence = describeRemoveConsequence(makeItem({ file_count: 3, name: 'pdf-toolkit' }));

    expect(sentence).toContain('3 files');
    expect(sentence).toContain('"pdf-toolkit"');
    expect(sentence).toContain('commits the removal');
  });

  test('uses singular "file" for a single-file item', () => {
    const sentence = describeRemoveConsequence(makeItem({ file_count: 1 }));

    expect(sentence).toContain('1 file');
    expect(sentence).not.toContain('1 files');
  });

  test('prefers the catalog title over the raw name when available', () => {
    const sentence = describeRemoveConsequence(
      makeItem({ name: 'internal-slug-42' }),
      'Notion Sync',
    );

    expect(sentence).toContain('"Notion Sync"');
    expect(sentence).not.toContain('internal-slug-42');
  });
});

describe('updatableInstalledItemNames', () => {
  test('keeps only update-available entries', () => {
    const updates: { name: string; status: RegistryItemStatus }[] = [
      { name: 'a', status: 'update-available' },
      { name: 'b', status: 'up-to-date' },
      { name: 'c', status: 'orphaned' },
      { name: 'd', status: 'update-available' },
    ];

    expect(updatableInstalledItemNames(updates)).toEqual(['a', 'd']);
  });

  test('an empty updates list yields no updatable names', () => {
    expect(updatableInstalledItemNames([])).toEqual([]);
  });
});

describe('buildCatalogByName', () => {
  test('indexes catalog items by name', () => {
    const items = [{ name: 'pdf-toolkit' }, { name: 'notion-sync' }] as MarketplaceItem[];

    const map = buildCatalogByName(items);

    expect(map.get('pdf-toolkit')).toBe(items[0]);
    expect(map.get('notion-sync')).toBe(items[1]);
    expect(map.get('missing')).toBeUndefined();
  });

  test('an empty catalog produces an empty map', () => {
    expect(buildCatalogByName([]).size).toBe(0);
  });
});
