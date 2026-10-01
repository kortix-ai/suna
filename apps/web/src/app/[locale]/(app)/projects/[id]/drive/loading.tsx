import { Skeleton } from '@/components/ui/skeleton';

/**
 * Navigation boundary for /projects/[id]/drive: paints the page chrome on
 * click and gives the sidebar's prefetching Link something to cache (the
 * project layout is dynamic). Mirrors DriveView's frame so nothing shifts.
 */
export default function ProjectDriveLoading() {
  return (
    <div className="bg-background flex h-full min-h-0 flex-1 flex-col" aria-hidden>
      <div className="kx-titlebar-row kx-titlebar-band-height relative flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <Skeleton className="mx-3 h-4 w-12 rounded-sm" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="bg-sidebar hidden w-60 shrink-0 space-y-1 border-r px-2 py-3 md:block">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}
