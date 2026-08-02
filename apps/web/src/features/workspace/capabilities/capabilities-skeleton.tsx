import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { CATALOG_CARD_HEIGHT_CLASSNAME, GRID_CLASSNAME } from './catalog-grid';

/**
 * Placeholder chrome for the three capability routes (connectors, skills,
 * commands) while their page resolves.
 *
 * Shared by `(capabilities)/loading.tsx` (the navigation Suspense boundary),
 * so the sidebar's `<Link prefetch>` on ProjectConnectorsNavItem /
 * ProjectSkillsNavItem / ProjectCommandsNavItem has something to cache — same
 * reason `project-files-skeleton.tsx` exists for the Files entry.
 *
 * Matches `CapabilityPageShell`'s `max-w-5xl` header + grid shape (see
 * capability-page-shell.tsx's doc comment: "a 3-up card grid does not fit in
 * max-w-2xl") rather than today's `EmptyState` stub content, so this does not
 * need to change again once a later task wires that shell into the pages.
 *
 * The grid breakpoint and the card height both come from `catalog-grid.tsx`
 * (`GRID_CLASSNAME`, `CATALOG_CARD_HEIGHT_CLASSNAME`) instead of being
 * restated here — two hand-typed copies of the same number drift apart
 * silently, which is exactly how this file's breakpoint and card height
 * previously disagreed with the real grid. Importing the one real constant
 * removes the possibility, rather than just matching it by hand again.
 */
export function CapabilitiesSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-slot="capabilities-skeleton">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-10 pb-20 lg:py-14">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-6 w-32 rounded" />
            <Skeleton className="h-4 w-64 rounded" />
          </div>
          <Skeleton className="h-9 w-full rounded-md sm:max-w-xs" />
        </header>
        <div className={cn('grid-cols-1', GRID_CLASSNAME)}>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton
              key={index}
              className={cn(CATALOG_CARD_HEIGHT_CLASSNAME, 'w-full rounded-md')}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
