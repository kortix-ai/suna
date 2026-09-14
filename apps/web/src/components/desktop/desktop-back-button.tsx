'use client';

import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';

import { TITLEBAR_CONTROL_CLASS } from '@/components/desktop/titlebar-control';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import { cn } from '@/lib/utils';

/**
 * Back, for full-screen frames that carry no product navigation.
 *
 * The desktop shell has no browser toolbar. A frame with no sidebar and no
 * in-page exit — the auth consent and status screens, `/github/setup` before
 * the user continues — has nothing to click, so the user is stuck on it. This
 * is the missing toolbar button, drawn in the title-bar band.
 *
 * It renders on every platform. `.kx-desktop-back` in globals.css shows it only
 * under `html[data-desktop='true']`, so the web keeps the browser's own Back.
 * Gating in CSS instead of in React keeps server and client markup identical:
 * `DESKTOP_INIT_SCRIPT` sets the attribute before first paint.
 */

/** `window` with the Navigation API, which TypeScript's DOM lib does not declare yet. */
export type NavigationWindow = { navigation?: { canGoBack: boolean } };

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
 * `navigation.canGoBack` counts only the contiguous run of same-origin entries
 * around the current one, so it is `false` when the entry behind is github.com
 * or the window's initial `about:blank`. `history.length` is deliberately not
 * used: it counts cross-origin entries, and Electron's `will-navigate` gate
 * does not run for history traversal, so Back would load GitHub inside the app
 * window.
 *
 * `replace`, not `push`, for a target: the frame is a dead end, and pushing
 * would leave it one Back away again.
 */
export function goBack(
  router: Navigate,
  win: NavigationWindow,
  { to, home }: { to?: string; home: string },
): void {
  if (to) {
    router.replace(to);
  } else if (win.navigation?.canGoBack) {
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

/**
 * Back wired to this window's history. Rendered by `AuthFrame`.
 *
 * Signed-in only. Back leads into the app, and a signed-out visitor has no app
 * to return to: `/auth` is where they start, and forgot/reset password carry
 * their own "Back to sign in". `user` is `null` on the server and on the first
 * client render, so the gate cannot desync hydration.
 */
export function DesktopBackButton({ href }: { href?: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const home = useAppHome();
  if (!user) return null;
  return (
    <DesktopBackControl
      onBack={() => goBack(router, window as Window & NavigationWindow, { to: href, home })}
    />
  );
}
