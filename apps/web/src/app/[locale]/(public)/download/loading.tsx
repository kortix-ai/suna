import { RouteLoadingFallback } from '@/components/common/route-loading';

/**
 * Navigation Suspense boundary for `/download`.
 *
 * The page awaits `headers()` and fetches the latest release, so it is dynamic,
 * and Next prefetches a dynamic route only as far as its nearest loading
 * boundary (node_modules/next/dist/docs/01-app/02-guides/prefetching.md:31).
 * Both menu rows that link here — the sidebar workspace switcher and the header
 * user menu — carry `prefetch`, which without this file cached nothing and left
 * the click paying a cold RSC fetch.
 */
export default function DownloadLoading() {
  return <RouteLoadingFallback />;
}
