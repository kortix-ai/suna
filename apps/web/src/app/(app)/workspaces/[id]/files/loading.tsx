import { WorkspaceFilesSkeleton } from '@/features/workspace/workspace-layout/workspace-files-skeleton';

/**
 * Navigation Suspense boundary for /projects/[id]/files.
 *
 * Two jobs:
 *  1. Paint Drive chrome the instant the click lands, instead of leaving the
 *     previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a cacheable prefetch target. This route is dynamic — the
 *     project layout awaits cookies() — and for a dynamic route Next.js
 *     prefetches only as far as the nearest loading boundary. Without this
 *     file the sidebar's `<Link prefetch>` has nothing to store.
 *
 * The wrapper div mirrors `page.tsx` so the handover does not shift layout.
 */
export default function WorkspaceFilesLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspaceFilesSkeleton />
    </div>
  );
}
