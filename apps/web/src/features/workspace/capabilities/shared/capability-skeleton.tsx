import { Skeleton } from '@/components/ui/skeleton';

import { CatalogGridSkeleton } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';

/**
 * Placeholder chrome for the capability routes (agents, connectors,
 * skills) while their page resolves.
 *
 * Shared by `(capabilities)/loading.tsx` (the navigation Suspense boundary),
 * so the sidebar's `<Link prefetch>` on ProjectCustomizeNavItem has something
 * to cache — same reason `project-files-skeleton.tsx` exists for the Files
 * entry.
 *
 * Matches `CapabilityPageShell`'s `max-w-5xl` header, then hands the grid to
 * `CatalogGridSkeleton` — the same loading chrome each page renders once its
 * query is in flight. One skeleton for navigation prefetch and in-page load.
 */
export function CapabilitiesSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-slot="capability-skeleton">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-10 pb-20 lg:py-14">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-6 w-24 rounded-sm py-0" />
            <Skeleton className="h-4 w-56 rounded-sm py-0" />
          </div>
          <Skeleton className="h-9 w-full rounded-md py-0 sm:w-64" />
        </header>
        <CatalogGridSkeleton />
      </div>
    </div>
  );
}
