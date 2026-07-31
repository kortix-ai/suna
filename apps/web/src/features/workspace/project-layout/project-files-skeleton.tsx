import { Skeleton } from '@/components/ui/skeleton';

/**
 * Drive chrome placeholder for the standalone Files page.
 *
 * Shared by `projects/[id]/files/loading.tsx` (the navigation Suspense
 * boundary) and `ProjectFilesView`'s pre-ref state, so the two can never
 * disagree about layout and the paint does not shift as one hands over to the
 * other.
 *
 * Deliberately imports nothing from `@/features/project-files` (9,291 LOC) or
 * `@/features/file-viewer` (1,877 LOC): this renders inside the loading
 * boundary, so anything imported here lands in the very payload that is
 * supposed to arrive first. `files-route-contract.test.ts` enforces it by
 * inspecting import specifiers, so naming those modules here is safe.
 */
export function ProjectFilesSkeleton() {
  return (
    <div className="bg-background flex h-full flex-col" data-slot="project-files-skeleton">
      {/* DriveHeader — h-12 with a bottom border, matching drive-header.tsx */}
      <div className="border-border/40 flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-28 rounded" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      </div>

      {/* DriveToolbar — breadcrumbs on the left, version selector on the right */}
      <div className="border-border/40 flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Skeleton className="h-4 w-20 rounded" />
        <Skeleton className="size-3 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-7 w-24 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 p-4">
        {Array.from({ length: 10 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded" />
        ))}
      </div>
    </div>
  );
}
