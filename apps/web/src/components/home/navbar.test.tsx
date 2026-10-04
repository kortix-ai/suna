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

const header = () => container!.querySelector('header');

test('the bar renders the brand, the desktop nav and a GitHub stars chip', async () => {
  await mountNavbar();
  const html = container!.innerHTML;
  expect(header()).not.toBeNull();
  expect(html).toContain('4,321');
  // The desktop navigation renders every top-level site link.
  expect(html).toContain('href="/pricing"');
});

test('over a dark hero the bar is transparent until the reader scrolls past the threshold', async () => {
  const hero = win.document.createElement('section');
  hero.setAttribute('data-kx-dark-hero', '');
  win.document.body.appendChild(hero);
  await mountNavbar();
  const bar = header()!;
  expect(bar.className).toContain('bg-transparent');
  await act(async () => {
    win.scrollTo(0, 200);
    win.dispatchEvent(new win.Event('scroll'));
  });
  expect(bar.className).toContain('bg-background');
  // The thresholds are asymmetric on purpose: the bar only expands again below
  // 20px, so a reader hovering around the 50px trigger never sees it flicker.
  await act(async () => {
    win.scrollTo(0, 30);
    win.dispatchEvent(new win.Event('scroll'));
  });
  expect(bar.className).toContain('bg-background');
  await act(async () => {
    win.scrollTo(0, 10);
    win.dispatchEvent(new win.Event('scroll'));
  });
  expect(bar.className).toContain('bg-transparent');
  hero.remove();
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

test('a drawer row click closes the drawer and unlocks body scroll', async () => {
  (win as unknown as { innerWidth: number }).innerWidth = 480;
  await mountNavbar();
  const open = container!.querySelector('[aria-label="componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu"]');
  await act(async () => {
    lib.click(open!);
  });
  expect(win.document.body.style.overflow).toBe('hidden');
  const drawer = container!.querySelector('.bg-background.fixed.inset-0');
  expect(drawer).not.toBeNull();
  const row = drawer!.querySelector<HTMLAnchorElement>('a[href="/pricing"]');
  expect(row).not.toBeNull();
  await act(async () => {
    lib.click(row!);
  });
  // The drawer closed either way.
  expect(win.document.body.style.overflow).toBe('');
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
