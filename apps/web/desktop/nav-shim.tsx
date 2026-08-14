'use client';

// Desktop-export shim for `next/navigation`.
//
// WHY THIS EXISTS
// The desktop bundle is a static export (`output: 'export'`). A statically
// exported dynamic route has to be prerendered against a concrete param set,
// and real project/session ids only exist at runtime, so every dynamic segment
// is exported once against the placeholder `__shell__` (see build.mjs). The
// Electron `app://` handler then serves that one shell for every concrete URL.
//
// The consequence: the router hydrates from the shell's flight payload, which
// has `__shell__` baked into it. Measured on Next 16.3.0, both on a deep link
// and after a client-side navigation:
//
//   usePathname() -> '/projects/realproj/sessions/realsess/'   (correct)
//   useParams()   -> { id: '__shell__', sessionId: '__shell__' }  (wrong)
//
// `apps/web` reads `useParams()` in 95 places, so patching call sites is not
// the fix. `next/navigation` is aliased to this module for the desktop build
// only (next.config.ts, turbopack.resolveAlias), which corrects all 95 at once
// and leaves the web build completely untouched.
//
// Params are recovered by matching the live pathname against the route
// patterns that were actually exported. That list is generated from the app
// directory at build time rather than hand-maintained, so a new dynamic route
// cannot silently miss it.
//
// Imports below deliberately reference `next/dist/client/components/navigation`
// — the module `next/navigation` itself re-exports. Importing `next/navigation`
// here would resolve through the alias back into this file and deadlock the
// build with a circular reference (observed, not theorised).

import {
  useParams as useRouterParams,
  usePathname,
} from 'next/dist/client/components/navigation';

import { ROUTE_PATTERNS } from './route-patterns.generated';

export * from 'next/dist/client/components/navigation';

/**
 * Match a live pathname against one exported route pattern.
 *
 * Returns the extracted params, or null when the pattern does not apply. A
 * pathname is allowed to be LONGER than the pattern: `/projects/[id]` still
 * matches `/projects/abc/files`, which is what makes a parent layout reading
 * `useParams().id` work on every descendant route.
 */
function matchPattern(pathname: string, pattern: string): Record<string, string> | null {
  const pathSegments = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);
  if (pathSegments.length < patternSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i];
    if (segment.startsWith('[') && segment.endsWith(']')) {
      const name = segment.slice(1, -1).replace(/^\.\.\./, '');
      params[name] = decodeURIComponent(pathSegments[i]);
    } else if (segment !== pathSegments[i]) {
      return null;
    }
  }
  return params;
}

export function useParams<T = Record<string, string | string[]>>(): T {
  const pathname = usePathname();
  const routerParams = (useRouterParams() ?? {}) as Record<string, string>;

  if (!pathname) return routerParams as T;

  // ROUTE_PATTERNS is ordered most-specific-first, so the first match is the
  // deepest route that applies and yields the most params.
  for (const pattern of ROUTE_PATTERNS) {
    const matched = matchPattern(pathname, pattern);
    if (matched) return { ...routerParams, ...matched } as T;
  }

  return routerParams as T;
}
