import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { groupByDomain } from '@kortix/sdk';

import { CatalogDomainSections } from './catalog-domain-sections';

type Item = { name: string; domain?: string | null };

const items: Item[] = [
  { name: 'builder', domain: 'engineering' },
  { name: 'writer', domain: 'marketing' },
  { name: 'helper' }, // no domain → default bucket
  { name: 'scout', domain: 'security' }, // referenced, undeclared
];
const domains = [
  { name: 'marketing', label: 'Marketing', order: 2 },
  { name: 'engineering', label: 'Engineering', order: 1 },
];

function markup(its: Item[], doms?: typeof domains) {
  return renderToStaticMarkup(
    <CatalogDomainSections
      groups={groupByDomain(its, doms)}
      renderCard={(it) => <span key={it.name}>{it.name}</span>}
    />,
  );
}

describe('CatalogDomainSections', () => {
  test('renders a labelled section per domain, with counts', () => {
    const html = markup(items, domains);
    expect(html).toContain('>Engineering ');
    expect(html).toContain('>Marketing ');
    expect(html).toContain('>security '); // undeclared → slug label
    expect(html).toContain('>General '); // default bucket
    // counts render beside the label
    expect(html).toContain('>1<'); // each of these groups has one item
  });

  test('orders declared (by order), then undeclared, then default last', () => {
    const html = markup(items, domains);
    const at = (s: string) => html.indexOf(s);
    expect(at('>Engineering ')).toBeLessThan(at('>Marketing '));
    expect(at('>Marketing ')).toBeLessThan(at('>security '));
    expect(at('>security ')).toBeLessThan(at('>General '));
  });

  test('backward compatible: no domains → one default section with every item', () => {
    const html = markup([{ name: 'a' }, { name: 'b' }]);
    expect(html).toContain('>General ');
    expect(html).toContain('>a</span>');
    expect(html).toContain('>b</span>');
    // only one section
    expect(html.match(/<section/g)?.length).toBe(1);
  });
});
