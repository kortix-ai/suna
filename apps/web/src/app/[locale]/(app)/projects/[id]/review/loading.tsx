import { Skeleton } from '@/components/ui/skeleton';

/**
 * Navigation Suspense boundary for /projects/[id]/review: paints the page frame
 * at once, so the sidebar's prefetch has a cacheable target and the handover
 * to the inbox does not shift layout.
 */
export default function ProjectReviewLoading() {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <div className="kx-titlebar-row kx-titlebar-band-height shrink-0 border-b" />
      <div className="w-full space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((key) => (
          <Skeleton key={key} className="h-10 rounded-md" />
        ))}
      </div>
    </div>
  );
}
