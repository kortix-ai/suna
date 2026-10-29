import { describe, expect, test } from 'bun:test';
import { filterLinks, linkFiltersFromParams, linkHost, linkPathTitle, linkTitle } from './space-link-label';

describe('space link label', () => {
  test('host drops www.', () => {
    expect(linkHost('https://www.youtube.com/watch?v=1')).toBe('youtube.com');
    expect(linkHost('not a url')).toBe('not a url');
  });

  test('the path is decoded and trimmed of its slashes', () => {
    expect(linkPathTitle('https://paper.design/file/Pricing%20page/')).toBe('file/Pricing page');
    expect(linkPathTitle('https://a.com/search?q=price+per+seat')).toBe('search?q=price per seat');
    expect(linkPathTitle('https://a.com/bad%E0%A4%A')).toBe('bad%E0%A4%A');
    expect(linkPathTitle('https://en.wikipedia.org/wiki/C++')).toBe('wiki/C++');
  });

  test('a bare host has no path title', () => {
    expect(linkPathTitle('https://notion.so/')).toBe('');
  });

  test('title: given title, else path, else host', () => {
    expect(linkTitle({ url: 'https://a.com/x', title: ' Spec ' })).toBe('Spec');
    expect(linkTitle({ url: 'https://a.com/x', title: null })).toBe('x');
    expect(linkTitle({ url: 'https://www.a.com/', title: null })).toBe('a.com');
    expect(linkTitle({ url: 'https://a.com/x', title: null, display_title: 'Pricing page' })).toBe('Pricing page');
    expect(linkTitle({ url: 'https://a.com/x', title: null, display_title: ' ' })).toBe('x');
  });
});

describe('link filters', () => {
  const now = new Date(2026, 9, 25, 15);
  const link = (over: Partial<Parameters<typeof filterLinks>[0][number]>) => ({
    url: 'https://example.com/',
    title: null,
    display_title: null,
    site_name: null,
    pinned: false,
    created_by: 'u-1',
    last_shared_at: new Date(2026, 9, 25, 9).toISOString(),
    ...over,
  });
  const links = [
    link({ url: 'https://snaps.design/', pinned: true, created_by: 'u-me' }),
    link({ url: 'https://mdtopdf.in/', display_title: 'Read MD to PDF', site_name: 'MD to PDF' }),
    link({ url: 'https://old.example.org/a', last_shared_at: new Date(2026, 9, 10).toISOString() }),
  ];
  const run = (query: string) => filterLinks(links, linkFiltersFromParams(new URLSearchParams(query)), 'u-me', now).map((l) => l.url);

  test('no filter keeps every link', () => {
    expect(run('')).toHaveLength(3);
  });

  test('search reads title, site name, host and URL, any case', () => {
    expect(run('q=read+md')).toEqual(['https://mdtopdf.in/']);
    expect(run('q=SNAPS')).toEqual(['https://snaps.design/']);
    expect(run('q=example.org/a')).toEqual(['https://old.example.org/a']);
  });

  test('pinned, by me / by id, and added windows narrow the list', () => {
    expect(run('pinned=1')).toEqual(['https://snaps.design/']);
    expect(run('by=me')).toEqual(['https://snaps.design/']);
    expect(run('by=u-1')).toHaveLength(2);
    expect(run('added=today')).toHaveLength(2);
    expect(run('added=last30')).toHaveLength(3);
    expect(run('added=bogus')).toHaveLength(3);
  });
});
