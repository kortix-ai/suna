import { RouteLoadingFallback } from '@/components/common/route-loading';

/**
 * Navigation Suspense boundary for `/new` — the "Create a workspace" entry in
 * the sidebar workspace switcher.
 *
 * Present for the same reason as `settings/loading.tsx`: every route here is
 * dynamic, and a dynamic route without a loading boundary is not prefetched at
 * all, so the switcher's link would still pay a cold RSC fetch on click.
 */
export default function NewWorkspaceLoading() {
  return <RouteLoadingFallback />;
}
