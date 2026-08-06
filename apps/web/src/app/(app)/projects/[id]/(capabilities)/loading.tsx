import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

/**
 * Navigation Suspense boundary for /projects/[id]/{connectors,skills,commands}.
 *
 * One file covers all three routes: `(capabilities)` is a route group whose
 * `layout.tsx` renders the shared tab bar around `{children}`; Next scopes
 * this `loading.tsx` to that same `{children}` slot, so it fires for whichever
 * of the three sibling pages is being navigated to.
 *
 * Two jobs, same as `files/loading.tsx`:
 *  1. Paint capability-page chrome the instant the click lands, instead of
 *     leaving the previous page frozen while the RSC payload and route chunk
 *     arrive.
 *  2. Give Next.js a cacheable prefetch target. `projects/[id]/layout.tsx`
 *     awaits cookies(), which makes every route under it dynamic, and for a
 *     dynamic route Next prefetches only as far as the nearest loading
 *     boundary. Without this file, the sidebar's `<Link prefetch>` on
 *     ProjectSettingsNavItem has nothing to store — every click would pay the
 *     full cold-navigation cost Files was fixed to avoid.
 */
export default function CapabilitiesLoading() {
  return <CapabilitiesSkeleton />;
}
