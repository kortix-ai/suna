'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Send a signed-out visitor to `/auth` — and back to `targetUrl` afterwards.
 *
 * The consent/authorize pages (OAuth, GitHub setup, device tunnel, CLI) each
 * need this: the middleware only gates the REQUEST, so a page reached signed
 * out (bookmarked, opened from another device) must leave for `/auth` itself
 * and carry where to come back to.
 *
 * `targetUrl` is the return destination BEFORE encoding. Pass a string when it
 * is known at render (`/tunnel/authorize/<code>`, the CLI page's own query) —
 * a change then re-fires the redirect, as the copied effects did. Pass a
 * function when the target is the CURRENT document URL: it reads
 * `window.location`, which does not exist during server render, so it is
 * called inside the effect and kept in a ref rather than the dependencies —
 * the redirect fires on the auth state, not on every render.
 *
 * The `/auth` side resolves `returnUrl` and the legacy `redirect` spelling
 * into the same sanitizer, so both spellings land in the same place.
 *
 * The `isSigningOut()` race stays in `useSignedOutRedirect` — these pages were
 * written without it and keep that behavior.
 */

/** Read the latest target: a function target is called, a string returned. */
function resolveTarget(target: string | (() => string)): string {
  return typeof target === 'function' ? target() : target;
}

export function useRequireSignedIn(targetUrl: string | (() => string)): void {
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const targetRef = useRef(targetUrl);
  // Keep the latest target without re-firing on identity: a function target is
  // a fresh closure every render, and re-running the redirect on every render
  // would loop the router. Written in an effect so it stays current by the
  // time the redirect effect below reads it (effects run in order).
  useEffect(() => {
    targetRef.current = targetUrl;
  });
  // A string target is part of the trigger set, like the copied effects' own
  // deps: the CLI page re-redirects when its query changes, the tunnel page
  // when the code changes.
  const stringTarget = typeof targetUrl === 'string' ? targetUrl : null;

  useEffect(() => {
    // Wait for the auth state to resolve first — a signed-in visitor's hard
    // load must not bounce to /auth and back while the identity is still
    // loading (the copied effects all gated on `!isLoading && !user`).
    if (isLoading) return;
    if (!user) {
      // String target: the dependency below re-fires the redirect when it
      // changes. Function target: read through the ref, never at render.
      const target = stringTarget ?? resolveTarget(targetRef.current);
      router.replace(`/auth?returnUrl=${encodeURIComponent(target)}`);
    }
  }, [isLoading, user, router, stringTarget]);
}
