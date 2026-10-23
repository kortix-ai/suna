import { describe, expect, test } from 'bun:test';
import { pageSlugs, renderPageMarkdown, resolveTokens } from './render';

describe('the read-only copy', () => {
  test('tokens become their source labels; a number with no source renders nothing', () => {
    const labels = new Map([[1, 'Q4 planning'], [2, 'Priya']]);
    expect(resolveTokens('- Launch Nov 12 ⟦1⟧\n- Copy by Priya ⟦2⟧ ⟦7⟧', labels)).toBe('- Launch Nov 12 [Q4 planning]\n- Copy by Priya [Priya] ');
  });

  test('the YAML header escapes a title with a colon and a newline', () => {
    const md = renderPageMarkdown({
      pageId: '11111111-2222-4333-8444-555555555555',
      type: 'decisions',
      title: 'Pricing: final\nanswer',
      summary: 'What we charge',
      body: 'Stays at $49 ⟦1⟧',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      updatedBy: 'Writer',
      sources: [{ number: 1, label: 'Pricing "call"', sessionId: null }],
    });
    expect(md).toContain('title: "Pricing: final\\nanswer"');
    expect(md).toContain('  - {n: 1, label: "Pricing \\"call\\"", thread: null}');
    expect(md).toContain('Stays at $49 [Pricing "call"]');
    expect(md.split('\n')[0]).toBe('---');
  });

  test('slugs: ASCII title, else page-<8 of id>; a clash takes -<6 of id>, oldest keeps the plain name', () => {
    const at = (s: number) => new Date(s * 1000);
    const slugs = pageSlugs([
      { pageId: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Q4 Launch!', createdAt: at(2) },
      { pageId: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'q4 launch', createdAt: at(1) },
      { pageId: 'cccccccc-0000-4000-8000-000000000003', title: '発売日', createdAt: at(3) },
      { pageId: 'dddddddd-0000-4000-8000-000000000004', title: 'Café pricing', createdAt: at(4) },
    ]);
    expect(slugs.get('dddddddd-0000-4000-8000-000000000004')).toBe('cafe-pricing');
    expect(slugs.get('aaaaaaaa-0000-4000-8000-000000000001')).toBe('q4-launch');
    expect(slugs.get('bbbbbbbb-0000-4000-8000-000000000002')).toBe('q4-launch-bbbbbb');
    expect(slugs.get('cccccccc-0000-4000-8000-000000000003')).toBe('page-cccccccc');
  });
});
