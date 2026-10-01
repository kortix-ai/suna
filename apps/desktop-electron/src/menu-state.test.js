const { describe, expect, test } = require('bun:test');

const { copyableUrl } = require('./menu-state');

describe('copyableUrl', () => {
  test('a session URL comes back unchanged', () => {
    const url = 'https://kortix.com/projects/p1/sessions/s1';
    expect(copyableUrl(url)).toBe(url);
  });

  test('the query and fragment survive, so a paste reopens the same view', () => {
    expect(copyableUrl('https://kortix.com/projects/p1/sessions/s1?tab=logs#anchor')).toBe(
      'https://kortix.com/projects/p1/sessions/s1?tab=logs#anchor',
    );
  });

  test('every in-app page is copyable: root, dashboard, settings, a self-hosted instance', () => {
    expect(copyableUrl('https://kortix.com/')).toBe('https://kortix.com/');
    expect(copyableUrl('https://kortix.com/new')).toBe('https://kortix.com/new');
    expect(copyableUrl('https://kortix.com/settings')).toBe('https://kortix.com/settings');
    expect(copyableUrl('http://localhost:3000/projects/p2/sessions/s2')).toBe(
      'http://localhost:3000/projects/p2/sessions/s2',
    );
  });

  test('a URL outside the app is not copyable', () => {
    expect(copyableUrl('https://github.com/kortix-ai/suna')).toBe(null);
    expect(copyableUrl('https://kortix.com/docs')).toBe(null);
  });

  test('a page a redirect committed or an error page is not copyable', () => {
    expect(copyableUrl('about:blank')).toBe(null);
    expect(copyableUrl('chrome-error://chromewebdata/')).toBe(null);
  });

  test('empty and unparseable input is not copyable', () => {
    expect(copyableUrl('')).toBe(null);
    expect(copyableUrl('not a url')).toBe(null);
  });
});
