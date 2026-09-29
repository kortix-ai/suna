import { Skeleton } from '@/components/ui/skeleton';

/**
 * Navigation Suspense boundary for /projects/[id]/reminders: paints the page
 * frame at once and gives the sidebar's hover prefetch a cacheable target (the
 * route is dynamic, so Next.js prefetches only up to this boundary). Mirrors
 * the view's frame so the handover does not shift layout.
 */
export default function ProjectRemindersLoading() {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <div className="kx-titlebar-row kx-titlebar-band-height shrink-0 border-b" />
      <div className="mx-auto w-full max-w-2xl space-y-2 px-4 py-10 lg:py-20">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-14 rounded-md" />
        ))}
      </div>
    </div>
  );
}
