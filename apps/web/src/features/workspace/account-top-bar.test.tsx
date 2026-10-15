import { describe, expect, test } from 'bun:test';

import { parseSettingsTab, type SettingsTab } from '@/features/workspace/settings/settings-tabs';

/**
 * KRTX-1742: the notification bell sits in the trailing group, before the
 * account menu, on `/projects`, `/new`, `/checkout` and `/connections`. The
 * menu itself lives in `AccountMenuButton` and is asserted in
 * `account-menu-button.test.tsx`; this file covers the top-bar composition.
 * The bell loads client-only, so the static renders of those pages
 * (project-selector.test.tsx) need no query client or auth provider.
 */
describe('AccountTopBar notification bell', () => {
  const source = async () => {
    const text = await Bun.file(new URL('./account-top-bar.tsx', import.meta.url)).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  test('the bell renders before the account menu', async () => {
    const code = await source();
    expect(code).toContain('<NotificationBell />');
    expect(code.indexOf('<NotificationBell />')).toBeLessThan(code.indexOf('<AccountMenuButton />'));
  });

  test('the bell is a client-only chunk', async () => {
    const code = await source();
    expect(code).toContain("import('@/features/notifications/notification-bell')");
    expect(code).toContain('{ ssr: false }');
  });
});

/**
 * KRTX-2145: the account control reaches every authenticated page. The bar
 * stays the account-level pages' top row, the project shell renders a floating
 * corner for chromeless project views, and views with a top row of their own
 * (capability headers, the session header) embed the chip in that row and
 * stamp the marker the shell's `:has([data-kx-account-owner])` rule reads.
 * Source-scan asserts the wiring; the rendered surfaces are proven in a
 * browser by `tests/e2e/specs/44-account-chip-ui.spec.ts`.
 */
describe('AccountTopBar app-wide wiring', () => {
  const strip = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('the floating corner renders the chip on chromeless project views', async () => {
    const code = strip(
      await Bun.file(
        new URL('./project-layout/project-shell.tsx', import.meta.url),
      ).text(),
    );
    expect(code).toContain('kx-app-account-corner');
    // The corner's chip is NOT embedded: a corner chip that stamped the marker
    // would hide itself forever (`:has([data-kx-account-owner])`).
    expect(code).toContain('<AccountMenuButton />');
    expect(code).not.toContain('<AccountMenuButton embedded');
  });

  test('a capability page header carries the embedded chip at its trailing edge', async () => {
    const code = strip(
      await Bun.file(
        new URL('./project-layout/project-page-header.tsx', import.meta.url),
      ).text(),
    );
    expect(code).toContain('<AccountMenuButton embedded />');
  });

  test('the shell stands its corner down on views that carry their own chip', async () => {
    const css = await Bun.file(new URL('../../app/globals.css', import.meta.url)).text();
    // The suppression rule and the corner class it hides.
    expect(css).toContain('[data-kx-titlebar-owner]:has([data-kx-account-owner]) .kx-app-account-corner');
    // Desktop: the corner clears the title-bar band with the same arithmetic
    // the `/new` top row uses.
    expect(css).toContain("html[data-desktop='true'] .kx-app-account-corner");
  });

  test('the session header carries the embedded chip too', async () => {
    const code = strip(
      await Bun.file(
        new URL('../session/header/session-site-header.tsx', import.meta.url),
      ).text(),
    );
    expect(code).toContain('<AccountMenuButton embedded />');
  });

  test('the standalone Settings row target is a real /settings segment', async () => {
    // Guard kept from the menu-row suite: every /settings href the chip renders
    // must be a segment the settings route accepts.
    const code = strip(
      await Bun.file(new URL('./account-menu-button.tsx', import.meta.url)).text(),
    );
    const tabs = [...code.matchAll(/href="\/settings\/([a-z-]+)"/g)].map((m) => m[1]);
    for (const tab of tabs) {
      expect(parseSettingsTab(tab)).toBe(tab as SettingsTab);
    }
  });
});
