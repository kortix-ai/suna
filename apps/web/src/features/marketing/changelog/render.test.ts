import { describe, expect, test } from 'bun:test';

import { CHANGELOG_PAGE_SIZE, changelogPageHref, paginateReleases } from './paging';
import { renderReleaseMarkdown } from './render';

describe('renderReleaseMarkdown', () => {
  test('renders GFM: headings, lists, tables, inline code', async () => {
    const html = await renderReleaseMarkdown(
      '## Fixes\n\n- one `code`\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    );
    expect(html).toContain('<h2>Fixes</h2>');
    expect(html).toContain('<li>one <code>code</code></li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>2</td>');
  });

  test('every link opens in a new tab and keeps only href', async () => {
    const html = await renderReleaseMarkdown('See [PR](https://github.com/x/y/pull/1 "t").');
    expect(html).toContain(
      '<a href="https://github.com/x/y/pull/1" target="_blank" rel="noopener noreferrer">PR</a>',
    );
  });

  test('autolinked URLs get the same treatment', async () => {
    const html = await renderReleaseMarkdown('https://example.com/a');
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">');
  });

  test('raw HTML and unsafe URLs never reach the output', async () => {
    const html = await renderReleaseMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });
});

describe('paginateReleases', () => {
  const releases = Array.from({ length: 45 }, (_, i) => ({ tag_name: `v0.0.${45 - i}` }));

  test('slices pages of CHANGELOG_PAGE_SIZE and indexes every tag', () => {
    const first = paginateReleases(releases, 1);
    expect(first.pageCount).toBe(Math.ceil(45 / CHANGELOG_PAGE_SIZE));
    expect(first.items).toHaveLength(CHANGELOG_PAGE_SIZE);
    expect(first.items?.[0]?.tag_name).toBe('v0.0.45');
    expect(first.tagPages['v0.0.45']).toBe(1);
    expect(first.tagPages['v0.0.1']).toBe(first.pageCount);
    const last = paginateReleases(releases, first.pageCount);
    expect(last.items).toHaveLength(45 - CHANGELOG_PAGE_SIZE * (first.pageCount - 1));
  });

  test('pages outside the range are null; page 1 exists even when empty', () => {
    expect(paginateReleases(releases, 0).items).toBeNull();
    expect(paginateReleases(releases, 99).items).toBeNull();
    expect(paginateReleases(releases, 1.5).items).toBeNull();
    expect(paginateReleases([], 1).items).toEqual([]);
  });

  test('page 1 is the bare /changelog URL', () => {
    expect(changelogPageHref(1)).toBe('/changelog');
    expect(changelogPageHref(3)).toBe('/changelog/page/3');
  });
});
