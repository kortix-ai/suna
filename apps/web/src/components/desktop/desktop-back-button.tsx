'use client';

import { ArrowLeftIcon } from '@phosphor-icons/react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

import { TITLEBAR_CONTROL_CLASS } from '@/components/desktop/titlebar-control';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import { cn } from '@/lib/utils';

/**
 * Back, for every screen that carries no product navigation.
 *
 * The desktop shell has no browser toolbar. A screen with no sidebar and no
 * in-page exit — `/new`, `/checkout`, a loading frame, an auth status screen —
 * has nothing to click, so the user is stuck on it. This is the missing toolbar
 * button, drawn in the title-bar band. The shell's Go menu (Back ⌘[, Forward
 * ⌘], Home ⇧⌘H, apps/desktop-electron/src/navigation.js) backs it up on pages
 * the web app does not render.
 *
 * It renders on every platform. `.kx-desktop-back` in globals.css shows it only
 * under `html[data-desktop='true']`, so the web keeps the browser's own Back.
 * Gating in CSS instead of in React keeps server and client markup identical:
 * `DESKTOP_INIT_SCRIPT` sets the attribute before first paint.
 */

/**
 * `window` with the Navigation API, which TypeScript's DOM lib does not declare
 * yet, and the desktop shell's history step (apps/desktop-electron/src/preload.js).
 * `navigate` resolves `true` when the shell moved; shells before it lack it.
 */
export type NavigationWindow = {
  navigation?: { canGoBack: boolean };
  kortixDesktop?: { navigate?: (direction: 'back' | 'forward') => Promise<boolean> };
};

/** The two router calls Back makes, and nothing else. */
type Navigate = Pick<ReturnType<typeof useRouter>, 'back' | 'replace'>;

/**
 * One Back click, in order:
 *
 * 1. `to`, when the frame knows where its flow started. `/github/setup` stores
 *    the page that opened it, which is a better answer than history.
 * 2. The previous page, when it belongs to this app.
 * 3. `home`.
 *
 * In the desktop shell, step 2 is the shell's own history step. A renderer
 * `history.back()` into a page the navigation gate keeps out of the window
 * (a redirect hop, a static file) is cancelled there and nothing happens; the
 * shell's step skips such entries instead.
 *
 * Elsewhere, `navigation.canGoBack` counts only the contiguous run of
 * same-origin entries around the current one, so it is `false` when the entry
 * behind is github.com or the window's initial `about:blank`. `history.length`
 * is deliberately not used: it counts cross-origin entries.
 *
 * `replace`, not `push`, for a target: the frame is a dead end, and pushing
 * would leave it one Back away again.
 */
export async function goBack(
  router: Navigate,
  win: NavigationWindow,
  { to, home }: { to?: string; home: string },
): Promise<void> {
  if (to) {
    router.replace(to);
    return;
  }
  const shellNavigate = win.kortixDesktop?.navigate;
  if (shellNavigate) {
    if (!(await shellNavigate('back'))) router.replace(home);
    return;
  }
  if (win.navigation?.canGoBack) {
    router.back();
  } else {
    router.replace(home);
  }
}

/**
 * The control alone, with no router or auth, so its DOM contract renders in a
 * test. Icon plus label: a bare arrow in the corner reads as window chrome, and
 * the word says what the click does.
 */
export function DesktopBackControl({ onBack }: { onBack: () => void }) {
  const t = useTranslations('common');
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onBack}
      className={cn(TITLEBAR_CONTROL_CLASS, 'kx-desktop-back gap-1.5 px-2 text-sm')}
    >
      <ArrowLeftIcon className="cn-rtl-flip size-4 shrink-0" />
      {t('back')}
    </Button>
  );
}

/* ─── Page-declared target ──────────────────────────────────────────────────
   One Back exists per window, mounted by the root layout. A page that knows
   where its flow started declares it with `useDesktopBackTarget`; the latest
   mounted declaration wins and is dropped on unmount. */

let backTarget: string | undefined;
const backTargetListeners = new Set<() => void>();

function setBackTarget(next: string | undefined) {
  if (backTarget === next) return;
  backTarget = next;
  for (const listener of backTargetListeners) listener();
}

function subscribeBackTarget(listener: () => void) {
  backTargetListeners.add(listener);
  return () => {
    backTargetListeners.delete(listener);
  };
}

/** Where the window's Back goes while the calling component is mounted. */
export function useDesktopBackTarget(href: string | undefined): void {
  useEffect(() => {
    if (!href) return;
    setBackTarget(href);
    return () => {
      if (backTarget === href) setBackTarget(undefined);
    };
  }, [href]);
}

/** Pathname of an app href, for comparing against `usePathname()`. */
function hrefPath(href: string): string {
  return href.split(/[?#]/)[0] || '/';
}

/**
 * Whether Back has anywhere to go. It has nowhere when there is no declared
 * target, no in-app entry behind the page, and the page already is home — a
 * click would replace the page with itself.
 */
export function hasBackDestination(
  win: NavigationWindow,
  { to, home, pathname }: { to?: string; home: string; pathname: string },
): boolean {
  return Boolean(to) || Boolean(win.navigation?.canGoBack) || hrefPath(home) !== pathname;
}

/**
 * The window's one Back, mounted by the root layout so every screen has an
 * exit by default — a screen added tomorrow needs no opt-in.
 *
 * Screens whose shell already navigates (the project shell, the admin shell,
 * the marketing navbar) wear `data-kx-titlebar-owner`; `.kx-desktop-back` in
 * globals.css hides Back under that marker, because those shells draw their
 * own control in the same corner of the band.
 *
 * Signed-in only. Back leads into the app, and a signed-out visitor has no app
 * to return to: `/auth` is where they start, and forgot/reset password carry
 * their own "Back to sign in". `user` is `null` on the server and on the first
 * client render, so the gate cannot desync hydration.
 */
export function DesktopBackButton() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const home = useAppHome();
  const to = useSyncExternalStore(
    subscribeBackTarget,
    () => backTarget,
    () => undefined,
  );
  if (!user) return null;
  const win = window as Window & NavigationWindow;
  if (!hasBackDestination(win, { to, home, pathname })) return null;
  return <DesktopBackControl onBack={() => void goBack(router, win, { to, home })} />;
}
