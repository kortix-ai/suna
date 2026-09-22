import { describe, expect, test } from 'bun:test';

import { wsDomain, wsFavicon, wsRootDomain } from './web-helpers';

describe('web helper URL labels', () => {
  test('wsFavicon resolves a page URL to its favicon service URL', () => {
    expect(wsFavicon('https://www.example.com/a?b=1')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=128',
    );
    expect(wsFavicon('not a url')).toBeNull();
  });

  test('wsDomain and wsRootDomain drop www and group subdomains', () => {
    expect(wsDomain('https://www.example.com/a')).toBe('example.com');
    expect(wsDomain('not a url')).toBe('not a url');
    expect(wsRootDomain('https://photos.google.com/x')).toBe('google.com');
  });
});
