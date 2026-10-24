import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { groupBySpace } from '@kortix/sdk';

import { ALL_SPACES, CatalogSpaceTabs } from './catalog-space-tabs';

type Item = { name: string; space?: string | null };

const items: Item[] = [
  { name: 'builder', space: 'engineering' },
  { name: 'refactorer', space: 'engineering' },
  { name: 'writer', space: 'marketing' },
  { name: 'helper' }, // default bucket
];
const spaces = [
  { name: 'engineering', label: 'Engineering', order: 1 },
  { name: 'marketing', label: 'Marketing', order: 2 },
];

function markup(its: Item[], sps?: typeof spaces) {
  return renderToStaticMarkup(
    <CatalogSpaceTabs groups={groupBySpace(its, sps)} value={ALL_SPACES} onValueChange={() => {}} />,
  );
}

describe('CatalogSpaceTabs', () => {
  test('renders All plus one tab per space, each with its count', () => {
    const html = markup(items, spaces);
    expect(html).toContain('All');
    expect(html).toContain('Engineering');
    expect(html).toContain('Marketing');
    expect(html).toContain('Project-wide'); // default bucket is a selectable tab too
    expect(html).toContain('>2<'); // engineering count
  });

  test('renders nothing when the project has no real space split', () => {
    // Only the default bucket → no filter worth showing.
    expect(markup([{ name: 'a' }, { name: 'b' }])).toBe('');
  });
});
