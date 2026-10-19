import { describe, expect, test } from 'bun:test';

import type { CatalogEntry } from './catalog-entry';
import { mergeSearchEntries } from './merge-search';

const managed = (name: string, icon: string): CatalogEntry =>
  ({
    source: 'easy-connect',
    key: `easy-connect:${name}`,
    slug: name.toLowerCase(),
    name,
    description: null,
    icon,
    categories: [],
    popularity: null,
    app: {} as never,
  }) as CatalogEntry;

const direct = (name: string, icon: string): CatalogEntry =>
  ({
    source: 'discover',
    key: `discover:${name}`,
    slug: name.toLowerCase(),
    name,
    description: null,
    icon,
    categories: [],
    popularity: null,
    connector: {} as never,
  }) as CatalogEntry;

describe('mergeSearchEntries', () => {
  test('an app in both catalogues shows once: the MCP entry, with the managed logo', () => {
    const merged = mergeSearchEntries(
      [managed('Miro', 'sharp.svg'), managed('Mural', 'mural.svg')],
      [direct('Miro', 'blurry.ico'), direct('Miro Boards', 'boards.ico')],
    );
    expect(merged.map((e) => [e.source, e.name, e.icon])).toEqual([
      ['discover', 'Miro', 'sharp.svg'],
      ['easy-connect', 'Mural', 'mural.svg'],
      ['discover', 'Miro Boards', 'boards.ico'],
    ]);
  });

  test('names match across case and punctuation', () => {
    const merged = mergeSearchEntries(
      [managed('Google Sheets', 'g.svg')],
      [direct('google-sheets', 'x')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.icon).toBe('g.svg');
  });
});
