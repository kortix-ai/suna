import { describe, expect, test } from 'bun:test';

/**
 * What is NOT covered here, and why.
 *
 * The switcher's menu rows live inside a Radix `DropdownMenuContent`, which
 * renders nothing until the menu is open and then renders through a portal.
 * `apps/web` has no DOM harness — no jsdom, no testing-library — and
 * `renderToStaticMarkup` returns an empty string for portalled content
 * (`features/workspace/account-top-bar.test.tsx` documents the same limit),
 * so the rows are not reachable from a unit test; the real menu is verified
 * in a browser journey (`tests/e2e/specs/38-project-shell-account-menu.spec.ts`).
 * What IS reachable is the wiring the menu is built from, which is what the
 * source-scan tests below read. Comments are stripped before matching, so the
 * prose in the component cannot defeat an absence assertion.
 */
describe('WorkspaceSwitcher account menu', () => {
  const source = async () => {
    const text = await Bun.file(new URL('./workspace-switcher.tsx', import.meta.url)).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  /**
   * KRTX-1810: inside a project the shell had no signed-in user
   * control at all — the "Logged in as" identity existed only on the account
   * top bar of /projects and /new, and the switcher menu opened straight on
   * the workspace sub-menu. The switcher is the shell's one "you" surface, so
   * its menu opens on the identity read from the auth session, reusing the
   * same copy the account pages show.
   */
  test('the menu opens on the signed-in identity from the auth session', async () => {
    const code = await source();
    expect(code).toContain('useAuth()');
    expect(code).toContain('account.loggedInAs');
  });

  test('the identity header sits above the Settings and Log out rows', async () => {
    const code = await source();
    const identity = code.indexOf('account.loggedInAs');
    const settings = code.indexOf("openUserSettings('profile')");
    const logout = code.indexOf("'workspace.logOut'");
    expect(identity).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(identity);
    expect(logout).toBeGreaterThan(settings);
  });
});
