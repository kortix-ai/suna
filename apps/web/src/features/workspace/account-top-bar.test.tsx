import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountMenuButton } from './account-menu-button';
import { ProjectAccountCorner } from './project-layout/project-shell';

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
 * KRTX-2145: the account control reaches every authenticated page, asserted on
 * RENDERED markup — a source scan passes even when the rendering is broken, so
 * the wiring claims here are proven by rendering the real components: the
 * shell's floating corner (extracted as `ProjectAccountCorner`) and the admin
 * console's header. The capability header and the session header have rendered
 * or browser owners of their own: `project-page-header.test.tsx` renders the
 * chip into the header's markup, and `tests/e2e/specs/52-account-chip-ui.spec.ts`
 * drives the session view and `/admin` in a real browser.
 */
const passthrough = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
  createElement('div', props, children);

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { email: 'dev@example.test', user_metadata: { name: 'Grace Hopper' } },
    session: null,
    isLoading: false,
  }),
}));
mock.module('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
}));
mock.module('next/link', () => ({
  // Faithful for static markup: the real Link spreads every non-Link prop
  // onto the anchor (tests count data-testid on rendered links) and consumes
  // its own navigation props.
  default: ({ href, children, prefetch, replace, scroll, shallow, locale, legacyBehavior, passHref, ...rest }:
    { href: string; children?: ReactNode; [key: string]: unknown }) =>
    createElement('a', { ...rest, href }, children),
}));
mock.module('@/components/ui/sidebar', () => ({
  SidebarEdgePeek: passthrough,
  SidebarInset: passthrough,
  SidebarProvider: passthrough,
  SidebarTrigger: passthrough,
  useSidebar: () => ({ state: 'expanded', isMobile: false }),
  useOptionalSidebar: () => undefined,
}));
mock.module('@/hooks/admin/use-admin-role', () => ({
  ADMIN_ROLE_QUERY_KEY: ['admin', 'role'],
  useAdminRole: () => ({ data: null, isLoading: false }),
}));

describe('AccountTopBar app-wide wiring, rendered', () => {
  test('the floating corner renders the chip, without the embedded marker', () => {
    const html = renderToStaticMarkup(createElement(ProjectAccountCorner));
    expect(html).toContain('kx-app-account-corner');
    expect(html).toContain('aria-label="Logged in as Grace Hopper"');
    // The corner's chip is NOT embedded: a corner chip that stamped the marker
    // would hide itself forever (`:has([data-kx-account-owner])`). This is the
    // rendered half of that contract; the CSS half is the next test.
    expect(html).not.toContain('data-kx-account-owner');
  });

  test('the suppression rule hides exactly the marker the embedded chips stamp', async () => {
    // The stylesheet is data, not component source: its contract is that the
    // `:has([data-kx-account-owner])` rule reads the same attribute the
    // embedded chips stamp in rendered markup. Both sides are checked here —
    // the rule from globals.css, the attribute from a rendered embedded chip —
    // so the CSS can never drift from the DOM it is meant to match.
    const css = await Bun.file(new URL('../../app/globals.css', import.meta.url)).text();
    const rule = css.match(
      /\[data-kx-titlebar-owner\]:has\(\[data-kx-account-owner\]\) \.kx-app-account-corner/,
    );
    expect(rule).not.toBeNull();
    // Desktop: the corner clears the title-bar band with the same arithmetic
    // the `/new` top row uses.
    expect(css).toContain("html[data-desktop='true'] .kx-app-account-corner");

    const embedded = renderToStaticMarkup(createElement(AccountMenuButton, { embedded: true }));
    expect(embedded).toContain('data-kx-account-owner');
    const corner = renderToStaticMarkup(createElement(ProjectAccountCorner));
    expect(corner).not.toContain('data-kx-account-owner');
  });

  test('the admin console header carries the embedded chip in its titlebar row', async () => {
    const { AdminHeader } = await import('../../app/[locale]/admin/_components/admin-shell');
    const html = renderToStaticMarkup(createElement(AdminHeader));
    expect(html).toContain('aria-label="Logged in as Grace Hopper"');
    // The chip lives in the header's titlebar row, stamped as the view that
    // owns the account surface — the marker the shell's suppression rule reads.
    expect(html).toContain('data-kx-account-owner');
    expect(html).toContain('kx-titlebar-row');
  });
});
