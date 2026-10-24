import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { groupBySpace } from '@kortix/sdk';

import { CatalogSpaceSections } from './catalog-space-sections';

type Item = { name: string; space?: string | null };

const items: Item[] = [
  { name: 'builder', space: 'engineering' },
  { name: 'writer', space: 'marketing' },
  { name: 'helper' }, // no space → default bucket
  { name: 'scout', space: 'security' }, // referenced, undeclared
];
const spaces = [
  { name: 'marketing', label: 'Marketing', order: 2 },
  { name: 'engineering', label: 'Engineering', order: 1 },
];

function markup(its: Item[], sps?: typeof spaces) {
  return renderToStaticMarkup(
    <CatalogSpaceSections
      groups={groupBySpace(its, sps)}
      renderCard={(it) => <span key={it.name}>{it.name}</span>}
    />,
  );
}

describe('CatalogSpaceSections', () => {
  test('renders a labelled section per space, with counts', () => {
    const html = markup(items, spaces);
    expect(html).toContain('>Engineering ');
    expect(html).toContain('>Marketing ');
    expect(html).toContain('>security '); // undeclared → slug label
    expect(html).toContain('>Project-wide '); // default bucket
    // counts render beside the label
    expect(html).toContain('>1<'); // each of these groups has one item
  });

  test('orders declared (by order), then undeclared, then default last', () => {
    const html = markup(items, spaces);
    const at = (s: string) => html.indexOf(s);
    expect(at('>Engineering ')).toBeLessThan(at('>Marketing '));
    expect(at('>Marketing ')).toBeLessThan(at('>security '));
    expect(at('>security ')).toBeLessThan(at('>Project-wide '));
  });

  test('backward compatible: no spaces → one default section with every item', () => {
    const html = markup([{ name: 'a' }, { name: 'b' }]);
    expect(html).toContain('>Project-wide ');
    expect(html).toContain('>a</span>');
    expect(html).toContain('>b</span>');
    // only one section
    expect(html.match(/<section/g)?.length).toBe(1);
  });
});
