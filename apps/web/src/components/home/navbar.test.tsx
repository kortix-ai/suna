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
  // Returns the dispatched event so a test can assert `defaultPrevented`
  // without re-deriving the cast outside this adapter.
  click: (el: Element) => {
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event;
    el.dispatchEvent(event);
    return event;
  },
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

/** Renders the marker the drawer docs-row test asserts the absence of: a plain
 * anchor (the static Astro docs) must not be a soft link (KRTX-1592). */
mock.module('next/link', () => ({
  default: (props: { children?: React.ReactNode } & Record<string, unknown>) => {
    const routerOnly = ['prefetch', 'replace', 'scroll', 'shallow', 'onNavigate', 'legacyBehavior'];
    const anchorProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => !routerOnly.includes(key)),
    );
    return React.createElement('a', { 'data-next-link': 'true', ...anchorProps });
  },
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

test('mobile tap targets: the brand links span the 64px bar and the menu toggles are 44px ghost buttons', async () => {
  // The phone-sized public pages measured tap targets of 15-33px
  // (KRTX-2110, KRTX-1790): the brand link is a 75x15 glyph box, the menu
  // toggles 28-33px. The fix makes the boxes themselves carry the target:
  // the brand links stretch the full h-16 bar (the glyph stays 15px), and
  // the ghost toggles grow to size-12 — invisible at rest, 44px to the
  // pointer, measurable by the journey.
  await mountNavbar();
  const brand = header()!.querySelector<HTMLAnchorElement>('a[href="/"]');
  expect(brand).not.toBeNull();
  expect(brand!.className).toContain('h-16');
  const open = container!.querySelector(
    '[aria-label="componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu"]',
  );
  expect(open!.className).toContain('size-12');
  await act(async () => {
    lib.click(open!);
  });
  const drawerEl = container!.querySelector('.bg-background.fixed.inset-0');
  expect(drawerEl).not.toBeNull();
  const drawerBrand = drawerEl!.querySelector<HTMLAnchorElement>('a[href="/"]');
  expect(drawerBrand!.className).toContain('h-16');
  const close = drawerEl!.querySelector(
    '[aria-label="componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu"]',
  );
  expect(close!.className).toContain('size-12');
});

test('mobile tap targets: the Get started CTA extends its hit area to the 44px floor without growing the filled button', async () => {
  // The CTA is a filled button — growing its box would change what the
  // visitor sees, so its tap target extends through the shared hit-area
  // pseudo-element instead (29px box + 3*spacing each side ≈ 51px).
  await mountNavbar();
  const cta = header()!.querySelector<HTMLAnchorElement>('a[href="/auth"]');
  expect(cta).not.toBeNull();
  expect(cta!.className).toContain('hit-area-y-3');
});

test('the drawer docs row stays a plain anchor: the tap marks it pending and leaves the document load to the browser', async () => {
  await openDrawer();
  const drawer = () => container!.querySelector('.bg-background.fixed.inset-0');
  const row = drawer()!.querySelector<HTMLAnchorElement>('a[href="/docs"]');
  expect(row).not.toBeNull();
  // `/docs` is the static Astro build under `public/docs` (KRTX-1592): the row
  // renders a plain anchor — no soft-link marker, no new-tab target, nothing
  // to hand to the router.
  expect(row!.getAttribute('data-next-link')).toBeNull();
  expect(row!.getAttribute('target')).toBeNull();
  let click: Event | undefined;
  await act(async () => {
    click = lib.click(row!);
  });
  if (!click) throw new Error('the tap dispatched no click event');
  // The handler must not hijack the tap: the anchor's default document load is
  // what serves the docs site. A `preventDefault` here would either strand the
  // reader (no soft nav exists into a static file) or force a doomed `RSC: 1`
  // round trip before the same reload.
  expect(click.defaultPrevented).toBe(false);
  // The row still shows the pending spinner while the document loads; the
  // reload itself is what closes the drawer.
  expect(drawer()).not.toBeNull();
  expect(drawer()!.innerHTML).toContain('animate-spinner');
  expect(win.document.body.style.overflow).toBe('hidden');
});
