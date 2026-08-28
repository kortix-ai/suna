'use client';

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

/**
 * A module-level handle on the App Router.
 *
 * Zustand stores, error handlers and the notification callback all need to
 * change route, and none of them is a React component, so none of them can call
 * `useRouter()`. Before this bridge they reached for `window.location.href`,
 * which never enters the App Router at all: every one of those navigations was
 * an unconditional full document reload — the whole SPA torn down and rebooted.
 *
 * `RouterBridge` (mounted once in the root layout) registers the live router
 * here. `softNavigate` then performs a normal client-side navigation from
 * anywhere.
 *
 * The `window.location` fallback stays for the window before the bridge
 * registers (a navigation fired from module scope during the first paint) and
 * for any non-browser context. It is a correctness backstop, not the happy
 * path — `softNavigate` returns `false` when it had to use it, so callers that
 * care can tell the difference.
 */
let appRouter: AppRouterInstance | null = null;

export function registerAppRouter(router: AppRouterInstance | null): void {
  appRouter = router;
}

/** Test-only. Drops the registered router so each test starts unbridged. */
export function __resetAppRouterForTests(): void {
  appRouter = null;
}

export function hasAppRouter(): boolean {
  return appRouter !== null;
}

/**
 * Navigate to an in-app `href`. Returns `true` when the App Router handled it
 * (a soft navigation) and `false` when it fell back to a document load.
 *
 * `replace` swaps the current history entry instead of pushing a new one.
 */
export function softNavigate(href: string, options?: { replace?: boolean }): boolean {
  if (appRouter) {
    if (options?.replace) appRouter.replace(href);
    else appRouter.push(href);
    return true;
  }
  if (typeof window !== 'undefined') {
    if (options?.replace) window.location.replace(href);
    else window.location.assign(href);
  }
  return false;
}

/**
 * Warm an in-app destination so the click that follows is served from the
 * segment cache instead of running a cold RSC fetch. A no-op when unbridged.
 */
export function softPrefetch(href: string): void {
  appRouter?.prefetch(href);
}
