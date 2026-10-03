import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountTopBar } from './account-top-bar';

/**
 * What is NOT covered here, and why.
 *
 * The menu's rows live inside a Radix `DropdownMenuContent`, which renders
 * nothing until the menu is open and then renders through a portal.
 * `renderToStaticMarkup` returns an empty string for portalled content and
 * `apps/web` has no DOM harness — the same situation
 * `features/layout/user-menu.test.tsx` documents for its menu. So the rows
 * themselves are not reachable from a unit test; they are verified in the
 * browser (see the KRTX-1327 PR). What IS reachable is asserted below: the
 * trigger renders, and — per the same file's source-scan pattern, the only
 * proof of a row's target without a DOM — the source carries the Settings row
 * above Log out.
 */
function render(): string {
  return renderToStaticMarkup(
    createElement(AccountTopBar, {
      email: 'user@example.test',
      signingOut: false,
      onLogOut: () => {},
    }),
  );
}

describe('AccountTopBar', () => {
  test('renders the identity trigger with the signed-in email', () => {
    const html = render();
    expect(html).toContain('Logged in as');
    expect(html).toContain('user@example.test');
  });

  test('the menu carries a Settings row pointing at /settings/profile, above Log out', async () => {
    const source = await Bun.file(new URL('./account-top-bar.tsx', import.meta.url)).text();
    // Comments are stripped so the prose cannot satisfy the match; the same
    // stripping `user-menu.test.tsx` uses.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('href="/settings/profile"');
    expect(code.indexOf('actions.settings')).toBeLessThan(code.indexOf('actions.logOut'));
  });
});
