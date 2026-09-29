const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { APP_PATH_PREFIXES, isAppPath, isPreviewHost } = require('./nav-rules');

/**
 * The web middleware's `DESKTOP_ALLOWED_ROUTES`, read from source. The shell
 * and the web app run in different processes and share no module, so the only
 * link between the two lists is this test.
 */
function middlewareDesktopRoutes() {
  const middleware = readFileSync(join(__dirname, '../../web/src/middleware.ts'), 'utf8');
  const block = middleware.match(/const DESKTOP_ALLOWED_ROUTES = \[([\s\S]*?)\];/);
  if (!block) throw new Error('DESKTOP_ALLOWED_ROUTES not found in apps/web/src/middleware.ts');
  const code = block[1].replace(/\/\/.*$/gm, '');
  return [...code.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('desktop navigation gate', () => {
  test('allows exactly the routes the web middleware allows on desktop', () => {
    // A route the middleware allows but the shell does not opens in the system
    // browser on a full-page load, and the app window stays where it was. That
    // is how a redirect to /settings/billing left the window stuck on /auth.
    expect([...APP_PATH_PREFIXES].sort()).toEqual(middlewareDesktopRoutes().sort());
  });

  test('keeps full-page loads to allowed routes in the app window', () => {
    expect(isAppPath('/settings/billing')).toBe(true);
    expect(isAppPath('/projects/p1/sessions/s1')).toBe(true);
    expect(isAppPath('/auth')).toBe(true);
    expect(isAppPath('/auth/callback')).toBe(true);
  });

  test('keeps the site root in the app window', () => {
    // `window.location.href = '/'` (account deletion) must not open the system
    // browser. On desktop the middleware sends `/` to the landing door.
    expect(isAppPath('/')).toBe(true);
  });

  test('sends everything else to the system browser', () => {
    expect(isAppPath('/pricing')).toBe(false);
    expect(isAppPath('/docs')).toBe(false);
    // Prefix match is by segment: `/newsroom` is not `/new`.
    expect(isAppPath('/newsroom')).toBe(false);
    // Removed routes the shell used to list.
    expect(isAppPath('/templates')).toBe(false);
    expect(isAppPath('/accounts')).toBe(false);
  });

  test('treats sandbox previews and tunnels as in-app hosts', () => {
    expect(isPreviewHost('abc.kortix.cloud')).toBe(true);
    expect(isPreviewHost('kortix.cloud')).toBe(true);
    expect(isPreviewHost('p1.localhost')).toBe(true);
    expect(isPreviewHost('evilkortix.cloud')).toBe(false);
    expect(isPreviewHost('github.com')).toBe(false);
  });
});
