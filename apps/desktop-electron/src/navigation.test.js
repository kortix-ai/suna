const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  APP_PATH_PREFIXES,
  NAVIGATION_SHORTCUTS,
  historyTarget,
  isAppPath,
} = require('./navigation');

const APP = 'https://kortix.com';
const inApp = (url) => {
  try {
    return new URL(url).origin === APP;
  } catch {
    return false;
  }
};
const entries = (...urls) => urls.map((url) => ({ url, title: '' }));

describe('historyTarget', () => {
  test('Back lands on the previous in-app entry', () => {
    const list = entries(`${APP}/projects/p1`, `${APP}/new`);
    expect(historyTarget(list, 1, 'back', inApp)).toBe(0);
  });

  test('Back skips entries the gate would have opened in the browser', () => {
    // A server redirect to github.com is committed in-window: will-navigate
    // never ran for it. Traversal must not reload it inside the app.
    const list = entries(
      `${APP}/projects/p1`,
      'https://github.com/login/oauth/authorize',
      `${APP}/github/setup`,
    );
    expect(historyTarget(list, 2, 'back', inApp)).toBe(0);
  });

  test('Back skips a hostname that only begins with the app origin', () => {
    const list = entries(
      `${APP}/projects/p1`,
      'https://kortix.com.attacker.example/projects/p2',
      `${APP}/new`,
    );
    expect(historyTarget(list, 2, 'back', inApp)).toBe(0);
  });

  test('Back has no target at the first in-app entry', () => {
    const list = entries('about:blank', `${APP}/new`);
    expect(historyTarget(list, 1, 'back', inApp)).toBe(-1);
  });

  test('Forward lands on the next in-app entry and skips the rest', () => {
    const list = entries(`${APP}/a`, 'https://github.com/x', `${APP}/b`);
    expect(historyTarget(list, 0, 'forward', inApp)).toBe(2);
    expect(historyTarget(list, 2, 'forward', inApp)).toBe(-1);
  });

  test('an out-of-range active index has no target', () => {
    expect(historyTarget([], -1, 'back', inApp)).toBe(-1);
    expect(historyTarget(entries(`${APP}/a`), 5, 'back', inApp)).toBe(-1);
  });
});

describe('NAVIGATION_SHORTCUTS', () => {
  test('follows Safari and Chrome on macOS, Chrome elsewhere', () => {
    expect(NAVIGATION_SHORTCUTS.darwin).toEqual({ back: 'Cmd+[', forward: 'Cmd+]', home: 'Cmd+Shift+H' });
    expect(NAVIGATION_SHORTCUTS.other).toEqual({ back: 'Alt+Left', forward: 'Alt+Right', home: 'Alt+Home' });
  });

  test('never claims Cmd+Left, which moves the caret in a text field', () => {
    expect(Object.values(NAVIGATION_SHORTCUTS.darwin)).not.toContain('Cmd+Left');
  });
});

describe('isAppPath', () => {
  test('every route the web middleware allows on desktop also loads in the window', () => {
    // A full-document navigation to a route the middleware allows but this
    // gate does not — `/settings/billing` after checkout — opened the system
    // browser and left the window where it was.
    const middleware = fs.readFileSync(
      path.join(__dirname, '../../web/src/middleware.ts'),
      'utf8',
    );
    const block = middleware.match(/const DESKTOP_ALLOWED_ROUTES = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const routes = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(10);
    const missing = routes.filter((route) => !APP_PATH_PREFIXES.includes(route));
    expect(missing).toEqual([]);
  });

  test('matches a prefix and its children, not a lookalike', () => {
    expect(isAppPath('/settings')).toBe(true);
    expect(isAppPath('/settings/billing')).toBe(true);
    expect(isAppPath('/settingsx')).toBe(false);
    expect(isAppPath('/auth')).toBe(true);
    expect(isAppPath('/auth/callback')).toBe(true);
    expect(isAppPath('/docs')).toBe(false);
  });
});
