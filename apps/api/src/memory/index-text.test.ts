import { describe, expect, test } from 'bun:test';
import { cachedIndex, indexGroups, type IndexPage, renderIndex, splitBudget } from './index-text';

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const page = (over: Partial<IndexPage>): IndexPage => ({
  type: 'decisions',
  title: 'Pricing',
  summary: 'What we charge',
  status: 'confirmed',
  updatedAt: at(1),
  path: '/opt/kortix/memory/channel/decisions/pricing.md',
  ...over,
});

describe('the page list agents receive', () => {
  test('types in table order, newest first, notes under "Notes to file", unconfirmed left out', () => {
    const text = renderIndex(
      indexGroups([
        page({ type: 'note', title: 'Launch Nov 12', summary: '', path: '/n.md' }),
        page({ title: 'Old', updatedAt: at(1), path: '/old.md' }),
        page({ title: 'New', updatedAt: at(5), path: '/new.md' }),
        page({ type: 'people', title: 'Priya', summary: 'Approves copy', path: '/p.md' }),
        page({ type: 'playbooks', title: 'Unchecked', status: 'unconfirmed', path: '/u.md' }),
      ]),
    );
    expect(text).toBe(
      [
        '## People',
        '- Priya — Approves copy (/p.md)',
        '',
        '## Decisions',
        '- New — What we charge (/new.md)',
        '- Old — What we charge (/old.md)',
        '',
        '## Notes to file',
        '- Launch Nov 12 (/n.md)',
      ].join('\n'),
    );
  });

  test('over budget, the oldest lines of the largest type go first and an overflow line ends the layer', () => {
    const pages = [
      page({ type: 'people', title: 'Priya', path: '/p.md' }),
      ...Array.from({ length: 5 }, (_, i) => page({ title: `D${i}`, updatedAt: at(i + 1), path: `/d${i}.md` })),
    ];
    const full = renderIndex(indexGroups(pages));
    const cut = renderIndex(indexGroups(pages), full.length - 1);
    expect(cut.length).toBeLessThanOrEqual(full.length - 1);
    expect(cut).toContain('- Priya');
    expect(cut).toContain('- D4');
    expect(cut).not.toContain('- D0 ');
    expect(cut.split('\n').at(-1)).toMatch(/^- …and \d+ more pages?: use memory_search\.$/);
  });

  test('budgets: Company 3,000, the others share 5,000, unused budget moves to a layer that needs it', () => {
    expect(splitBudget([{ scope: 'company', need: 100 }, { scope: 'channel', need: 100 }])).toEqual([3000, 5000]);
    expect(splitBudget([{ scope: 'company', need: 100 }, { scope: 'channel', need: 7000 }])).toEqual([3000, 7000]);
    expect(splitBudget([{ scope: 'company', need: 6000 }, { scope: 'channel', need: 1000 }])).toEqual([6000, 5000]);
    expect(splitBudget([{ scope: 'company', need: 0 }, { scope: 'channel', need: 0 }, { scope: 'dm', need: 0 }])).toEqual([3000, 2500, 2500]);
  });

  test('the render cache keys on layer and version', () => {
    let renders = 0;
    const render = () => `text ${++renders}`;
    expect(cachedIndex('layer-a', 1, render)).toBe('text 1');
    expect(cachedIndex('layer-a', 1, render)).toBe('text 1');
    expect(cachedIndex('layer-a', 2, render)).toBe('text 2');
  });
});
