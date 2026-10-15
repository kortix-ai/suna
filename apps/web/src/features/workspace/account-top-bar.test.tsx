import { describe, expect, mock, test } from 'bun:test';
import { type ReactNode, createElement } from 'react';
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
    expect(code.indexOf('<NotificationBell />')).toBeLessThan(
      code.indexOf('<AccountMenuButton />'),
    );
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
 * drives the session view (exactly one account control, in a real browser);
 * `tests/e2e/specs/09-admin-console.spec.ts` drives `/admin`.
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
  // Extra navigation exports the session header's transitive tree imports.
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegments: () => [],
  useSelectedLayoutSegment: () => null,
  useLinkStatus: () => ({ pending: false }),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
}));
mock.module('next/link', () => ({
  // Faithful for static markup: the real Link spreads every non-Link prop
  // onto the anchor (tests count data-testid on rendered links) and consumes
  // its own navigation props.
  default: ({
    href,
    children,
    prefetch,
    replace,
    scroll,
    shallow,
    locale,
    legacyBehavior,
    passHref,
    ...rest
  }: { href: string; children?: ReactNode; [key: string]: unknown }) =>
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
    // rendered half of that contract; the behavioral half lives in the browser
    // (spec 52 asserts the corner hidden on a header page and visible again on
    // the chromeless view the user navigates back to).
    expect(html).not.toContain('data-kx-account-owner');
  });

  test('the embedded chip stamps the marker the shell reads; the corner chip does not', () => {
    // Rendered, not source text: the marker is what the shell's suppression
    // rule matches on. Its VISIBILITY contract — the marker only while the
    // owning view is visible, so Next's hidden Activity cache cannot keep the
    // corner suppressed — is exercised in a real browser (spec 52); static
    // markup cannot run effects.
    const embedded = renderToStaticMarkup(createElement(AccountMenuButton, { embedded: true }));
    expect(embedded).toContain('data-kx-account-owner');
    const corner = renderToStaticMarkup(createElement(ProjectAccountCorner));
    expect(corner).not.toContain('data-kx-account-owner');
  });

  test('the desktop offset rule keeps the corner clear of the OS title-bar band', async () => {
    // Desktop-only positioning (the browser spec runs web), checked as data:
    // the corner clears the title-bar band with the same arithmetic the `/new`
    // top row uses.
    const css = await Bun.file(new URL('../../app/globals.css', import.meta.url)).text();
    expect(css).toContain("html[data-desktop='true'] .kx-app-account-corner");
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

  test('the session header carries the embedded chip in its titlebar row', async () => {
    const { SessionSiteHeader } = await import('@/features/session/header/session-site-header');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient({
      // Static render only: no query may fetch, so every hook stays pending.
      defaultOptions: { queries: { enabled: false, retry: false }, mutations: { retry: false } },
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionSiteHeader, { sessionId: 'probe-session', sessionTitle: 'Probe' }),
      ),
    );
    expect(html).toContain('aria-label="Logged in as Grace Hopper"');
    // Embedded, so the shell's floating corner stands down while this header
    // owns the account surface; the corner serves when the header has not
    // mounted yet (spec 52 drives that boot state in a real browser).
    expect(html).toContain('data-kx-account-owner');
    // The chip trails the row (after the dev tools), not the leading cluster.
    expect(html.indexOf('data-kx-account-owner')).toBeGreaterThan(html.indexOf('aria-label="Developer tools"'));
  });
});
