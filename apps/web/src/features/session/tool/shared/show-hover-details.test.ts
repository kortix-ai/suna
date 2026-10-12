import { describe, expect, test } from 'bun:test';

import { showHoverDetails } from './show-helpers';

describe('showHoverDetails', () => {
  test('a running port names the site, then the address it serves on', () => {
    const d = showHoverDetails({ url: 'http://localhost:3000/', title: 'Website preview' });
    expect(d?.name).toBe('Website preview');
    expect(d?.detail).toBe('localhost:3000');
  });

  test('an untitled port falls back to localhost:<port> and keeps its path', () => {
    const d = showHoverDetails({ url: 'http://localhost:5173/docs' });
    expect(d?.name).toBe('localhost:5173');
    expect(d?.detail).toBe('localhost:5173/docs');
  });

  test('a file names the file, then its full path', () => {
    const d = showHoverDetails({
      path: '/workspace/output/logo-gallery.html',
      title: 'Logo Gallery',
    });
    expect(d?.name).toBe('logo-gallery.html');
    expect(d?.detail).toBe('/workspace/output/logo-gallery.html');
  });

  test('a web link names its title or domain, then the full URL', () => {
    expect(showHoverDetails({ url: 'https://example.com/a' })?.name).toBe('example.com');
    expect(showHoverDetails({ url: 'https://example.com/a' })?.detail).toBe(
      'https://example.com/a',
    );
  });

  test('inline content with no path or URL has no card', () => {
    expect(showHoverDetails({ title: 'Notes' })).toBeNull();
    expect(showHoverDetails({ url: 'not a url' })).toBeNull();
  });
});
