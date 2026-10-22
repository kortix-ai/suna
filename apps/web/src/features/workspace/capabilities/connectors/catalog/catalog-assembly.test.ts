import { testUiTranslator } from '@/i18n/test-translator';
import { expect, test } from 'bun:test';
import { assembleCatalogEntries } from '@kortix/ui/customize/connectors/catalog/use-catalog';
test('empty provider pages stay empty and native computer search is local', () => {
  const input = {
    source: 'discover',
    computers: false,
    activeQuery: '',
    searchDirect: false,
    tI18nComplete: testUiTranslator,
  };
  // An explicit input annotation avoids widening the catalog discriminant.
  expect(assembleCatalogEntries({ ...input, source: 'discover' })).toEqual([]);
  expect(assembleCatalogEntries({ ...input, source: 'discover', computers: true })).toHaveLength(1);
  expect(
    assembleCatalogEntries({
      ...input,
      source: 'discover',
      computers: true,
      activeQuery: 'no-such-computer',
    }),
  ).toEqual([]);
});
