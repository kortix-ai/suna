import { describe, expect, test } from 'bun:test';
import { linkHost, linkPathTitle, linkTitle } from './space-link-label';

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
  });
});
