import { convexBetterAuthNextJs } from '@convex-dev/better-auth/nextjs';

/**
 * Better Auth on the Next.js server. `handler` proxies /api/auth/* to the
 * Convex site URL, so the session cookie is first-party on this origin.
 * `fetchAuthAction` / `fetchAuthMutation` call Convex as the signed-in user.
 *
 * Built on first use: the helpers throw without NEXT_PUBLIC_CONVEX_SITE_URL,
 * and `next build` imports route modules with no env set.
 */
type Helpers = ReturnType<typeof convexBetterAuthNextJs>;
let helpers: Helpers | null = null;

function auth(): Helpers {
  helpers ??= convexBetterAuthNextJs({
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL ?? '',
    convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? '',
  });
  return helpers;
}

export const handler = {
  GET: (request: Request) => auth().handler.GET(request),
  POST: (request: Request) => auth().handler.POST(request),
};
/** Forward a call to the lazily built helper, keeping its exact (generic) type. */
function lazy<K extends 'getToken' | 'fetchAuthAction' | 'fetchAuthMutation' | 'fetchAuthQuery'>(key: K): Helpers[K] {
  return ((...args: unknown[]) => (auth()[key] as (...a: unknown[]) => unknown)(...args)) as Helpers[K];
}

export const getToken = lazy('getToken');
export const fetchAuthAction = lazy('fetchAuthAction');
export const fetchAuthMutation = lazy('fetchAuthMutation');
export const fetchAuthQuery = lazy('fetchAuthQuery');
