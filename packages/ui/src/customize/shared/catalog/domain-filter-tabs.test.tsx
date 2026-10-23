import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { groupByDomain } from '@kortix/sdk';

import { ALL_DOMAINS, DomainFilterTabs } from './domain-filter-tabs';

type Item = { name: string; domain?: string | null };

const items: Item[] = [
  { name: 'builder', domain: 'engineering' },
  { name: 'refactorer', domain: 'engineering' },
  { name: 'writer', domain: 'marketing' },
  { name: 'helper' }, // default bucket
];
const domains = [
  { name: 'engineering', label: 'Engineering', order: 1 },
  { name: 'marketing', label: 'Marketing', order: 2 },
];

function markup(its: Item[], doms?: typeof domains) {
  return renderToStaticMarkup(
    <DomainFilterTabs groups={groupByDomain(its, doms)} value={ALL_DOMAINS} onValueChange={() => {}} />,
  );
}

describe('DomainFilterTabs', () => {
  test('renders All plus one tab per domain, each with its count', () => {
    const html = markup(items, domains);
    expect(html).toContain('All');
    expect(html).toContain('Engineering');
    expect(html).toContain('Marketing');
    expect(html).toContain('General'); // default bucket is a selectable tab too
    expect(html).toContain('>2<'); // engineering count
  });

  test('renders nothing when the project has no real domain split', () => {
    // Only the default bucket → no filter worth showing.
    expect(markup([{ name: 'a' }, { name: 'b' }])).toBe('');
  });
});
