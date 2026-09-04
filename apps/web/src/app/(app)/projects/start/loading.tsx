/**
 * Navigation Suspense boundary for /projects/start.
 *
 * The same two jobs as the sibling boundary at `projects/[id]/loading.tsx`:
 *  1. Paint the door's chrome the instant the click lands, instead of leaving
 *     the previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a prefetch target. This route is dynamic, and for a dynamic
 *     route Next.js prefetches only as far as the nearest loading boundary.
 *     Without this file, prefetching `/projects/start` is skipped altogether
 *     and every arrival pays a full server round-trip — which is what lets a
 *     bad RSC response turn the click into a full document load.
 *
 * Deliberately imports nothing: plain markup keeps the prefetched payload
 * small, which is the entire point of the boundary. It mirrors
 * `ProjectStartSkeleton` in `page.tsx` so the handover does not shift layout.
 */
export default function ProjectStartLoading() {
  return (
    <div className="flex min-h-screen flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Opening your project</span>
      <div className="w-full border-b">
        <div className="kx-app-header px-mobile mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-2 py-4 sm:gap-3">
          <div className="bg-muted-foreground/10 h-5 w-32 animate-pulse rounded-md" />
          <div className="bg-muted-foreground/10 h-8 w-20 animate-pulse rounded-full" />
        </div>
      </div>
      <main className="bg-background px-mobile flex flex-1 items-center py-10 sm:py-12">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="space-y-3">
            <div className="bg-muted-foreground/10 mx-auto h-9 w-64 animate-pulse rounded-md" />
            <div className="bg-muted-foreground/10 mx-auto h-5 w-96 max-w-full animate-pulse rounded-md" />
          </div>
          <div className="bg-muted-foreground/10 h-32 w-full animate-pulse rounded-lg" />
          <div className="flex flex-wrap justify-center gap-2">
            <div className="bg-muted-foreground/10 h-8 w-28 animate-pulse rounded-full" />
            <div className="bg-muted-foreground/10 h-8 w-36 animate-pulse rounded-full" />
            <div className="bg-muted-foreground/10 h-8 w-24 animate-pulse rounded-full" />
          </div>
        </div>
      </main>
    </div>
  );
}
