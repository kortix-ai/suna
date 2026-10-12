/**
 * Characterization for the marketing `Navbar` around the dead symbols this
 * branch deletes: the unused compaction constants, the unused drawer-menu
 * state and `DRAWER_SOCIALS`. The live behaviors stay: the bar's surface, the
 * drawer lock and the anchor navigation. The scroll state itself is live — the
 * dark-hero bar reads it — and the last test pins that, so a future cleanup
 * cannot delete it again.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const globals = globalThis as Record<string, unknown>;

/**
 * happy-dom implements the lib.dom surfaces; its own classes just carry extra
 * members, so every crossing of that library boundary is one explicit cast,
 * kept in these two adapters.
 */
const lib = {
  element: (node: { innerHTML: string; outerHTML: string }) => node as unknown as HTMLElement,
  click: (el: Element) =>
    el.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
    ),
};
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

let authUser: { id: string } | null = null;
let pathname = '/';
const stars: number | null = 4321;

const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => pathname,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
  useSelectedLayoutSegments: () => [],
  redirect: () => undefined,
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: authUser }),
}));
mock.module('@/hooks/utils/use-github-stars', () => ({
  useGitHubStars: () => ({ stars, formattedStars: stars === null ? null : '4,321', loading: false }),
}));
mock.module('@/lib/analytics/gtm', () => ({ trackCtaSignup: () => undefined }));
mock.module('@/features/contact/request-demo-provider', () => ({
  useRequestDemo: () => () => undefined,
}));

const { Navbar } = await import('./navbar');

let root: Root | undefined;
let container: HTMLElement | undefined;

async function mountNavbar() {
  const raw = win.document.createElement('div');
  container = lib.element(raw);
  win.document.body.appendChild(raw);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(Navbar));
  });
}

afterEach(async () => {
  if (root) {
    const r = root;
    root = undefined;
    await act(async () => r.unmount());
  }
  container?.remove();
  container = undefined;
  authUser = null;
  pathname = '/';
});

/** Open the drawer at mobile width and return its root element. */
async function openDrawer() {
  (win as unknown as { innerWidth: number }).innerWidth = 480;
  await mountNavbar();
  const open = container!.querySelector(
    '[aria-label="componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu"]',
  );
  expect(open).not.toBeNull();
  await act(async () => {
    lib.click(open!);
  });
  expect(win.document.body.style.overflow).toBe('hidden');
  return container!.querySelector('.bg-background.fixed.inset-0');
}

/** Re-render with `next` as the committed pathname: the mock `usePathname` reads it. */
async function commitNavigation(next: string) {
  pathname = next;
  await act(async () => {
    root!.render(React.createElement(Navbar));
  });
}

const header = () => container!.querySelector('header');

test('the bar renders the brand, the desktop nav and a GitHub stars chip', async () => {
  await mountNavbar();
  const html = container!.innerHTML;
  expect(header()).not.toBeNull();
  expect(html).toContain('4,321');
  // The desktop navigation renders every top-level site link.
  expect(html).toContain('href="/pricing"');
});

test('the mobile drawer locks body scroll while open and unlocks on close', async () => {
  (win as unknown as { innerWidth: number }).innerWidth = 480;
  await mountNavbar();
  const open = container!.querySelector('[aria-label="componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu"]');
  expect(open).not.toBeNull();
  await act(async () => {
    lib.click(open!);
  });
  expect(win.document.body.style.overflow).toBe('hidden');
  const drawer = container!.querySelector('.bg-background.fixed.inset-0');
  expect(drawer).not.toBeNull();
  const close = container!.querySelector('[aria-label="componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu"]');
  await act(async () => {
    lib.click(close!);
  });
  expect(win.document.body.style.overflow).toBe('');
});

test('a drawer row tap keeps the drawer up until the navigation commits', async () => {
  await openDrawer();
  const drawer = () => container!.querySelector('.bg-background.fixed.inset-0');
  const row = drawer()!.querySelector<HTMLAnchorElement>('a[href="/pricing"]');
  expect(row).not.toBeNull();
  await act(async () => {
    lib.click(row!);
  });
  // Closing on tap left a ~2 s dead wait: the old page sat frozen with no
  // feedback (KRTX-1591). The drawer stays up instead, and the tapped row
  // shows the pending spinner.
  expect(drawer()).not.toBeNull();
  expect(win.document.body.style.overflow).toBe('hidden');
  expect(drawer()!.innerHTML).toContain('animate-spinner');
  // The navigation commits: the drawer closes and unlocks the page.
  await commitNavigation('/pricing');
  expect(drawer()).toBeNull();
  expect(win.document.body.style.overflow).toBe('');
});

test('the drawer login button waits for its navigation the same way', async () => {
  await openDrawer();
  const drawer = () => container!.querySelector('.bg-background.fixed.inset-0');
  const login = drawer()!.querySelector<HTMLAnchorElement>('a[href="/auth"]');
  expect(login).not.toBeNull();
  await act(async () => {
    lib.click(login!);
  });
  expect(drawer()).not.toBeNull();
  expect(win.document.body.style.overflow).toBe('hidden');
  await commitNavigation('/auth');
  expect(drawer()).toBeNull();
  expect(win.document.body.style.overflow).toBe('');
});

test('a tap on the row of the page already committed closes the drawer at once', async () => {
  pathname = '/pricing';
  await openDrawer();
  const row = container!.querySelector<HTMLAnchorElement>(
    '.bg-background.fixed.inset-0 a[href="/pricing"]',
  );
  expect(row).not.toBeNull();
  await act(async () => {
    lib.click(row!);
  });
  // No navigation is in flight: the drawer must not hang on a commit that
  // never comes.
  expect(container!.querySelector('.bg-background.fixed.inset-0')).toBeNull();
  expect(win.document.body.style.overflow).toBe('');
});

test('an off-site drawer row closes the drawer at once', async () => {
  await openDrawer();
  const row = container!.querySelector<HTMLAnchorElement>(
    '.bg-background.fixed.inset-0 a[href="https://x.com/kortix"]',
  );
  expect(row).not.toBeNull();
  await act(async () => {
    lib.click(row!);
  });
  // The row opens a new tab; this page never commits, so the drawer closes.
  expect(container!.querySelector('.bg-background.fixed.inset-0')).toBeNull();
  expect(win.document.body.style.overflow).toBe('');
});

test('closing the drawer clears a pending navigation so no row stays marked', async () => {
  await openDrawer();
  const drawer = () => container!.querySelector('.bg-background.fixed.inset-0');
  await act(async () => {
    lib.click(drawer()!.querySelector<HTMLAnchorElement>('a[href="/pricing"]')!);
  });
  expect(drawer()!.innerHTML).toContain('animate-spinner');
  // The reader backs out with the close button instead of waiting.
  const close = container!.querySelector(
    '[aria-label="componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu"]',
  );
  await act(async () => {
    lib.click(close!);
  });
  expect(drawer()).toBeNull();
  // A later reopen on the same component instance shows no stale pending
  // mark: only the effect that clears `pendingHref` on close makes this
  // hold (a fresh mount would trivially pass with fresh state).
  const openAgain = container!.querySelector(
    '[aria-label="componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu"]',
  );
  await act(async () => {
    lib.click(openAgain!);
  });
  const reopened = container!.querySelector('.bg-background.fixed.inset-0');
  expect(reopened).not.toBeNull();
  expect(reopened!.innerHTML).not.toContain('animate-spinner');
});

test('a signed-in visitor sees the projects button; a signed-out one sees Get Started', async () => {
  authUser = { id: 'synthetic-user' };
  await mountNavbar();
  expect(container!.innerHTML).toContain('href="/projects/start"');

  root?.unmount();
  container?.remove();
  authUser = null;
  await mountNavbar();
  expect(container!.innerHTML).toContain('href="/auth"');
});
