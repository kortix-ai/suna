import { RouteLoadingFallback } from '@/components/common/route-loading';

/**
 * Navigation Suspense boundary for `/settings` and `/settings/[tab]`.
 *
 * It exists for the prefetch, not for the spinner. The root layout awaits
 * `connection()` and `headers()`, so EVERY route in this app is dynamic, and
 * Next prefetches a dynamic route only as far as its nearest loading boundary
 * (node_modules/next/dist/docs/01-app/02-guides/prefetching.md:31). Without this
 * file the user menu's "Settings" link had nothing to store: the click paid a
 * full cold RSC fetch, which is what exposes a navigation to the four
 * full-page-reload triggers in fetch-server-response.js.
 *
 * Same reasoning, same shape as `(capabilities)/loading.tsx`.
 */
export default function SettingsLoading() {
  return <RouteLoadingFallback />;
}
