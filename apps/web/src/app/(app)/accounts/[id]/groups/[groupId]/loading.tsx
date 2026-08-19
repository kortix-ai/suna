/**
 * Navigation Suspense boundary for /accounts/[id]/groups/[groupId].
 *
 * Same rationale as the sibling boundary at accounts/[id]/loading.tsx: without
 * this file, the ancestor accounts/loading.tsx animated logo splash covers
 * this route too, which reads as a jarring full-screen reset for what is
 * really "open a group from the list". Mirrors GroupDetailPage's own header
 * shell (back link, avatar, title, tab list) so the handover has no layout
 * shift.
 *
 * Deliberately imports no icon set: @phosphor-icons/react's IconContext
 * provider needs a Client Component boundary, and this file has to stay a
 * Server Component (see project-loading equivalent) — a route `loading.tsx`
 * that needed 'use client' would 500 with "createContext only works in
 * Client Components" instead of rendering the fallback.
 */
import { Skeleton } from '@/components/ui/skeleton';

export default function GroupDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-10">
      <div className="space-y-5">
        <div className="flex w-fit items-center gap-1 text-sm">
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 w-20 rounded-md" />
        </div>

        <div className="flex min-w-0 items-center gap-3.5">
          <Skeleton className="size-10 rounded-md" />
          <div className="min-w-0 space-y-0.5">
            <Skeleton className="h-6 w-44" />
          </div>
        </div>
      </div>

      <div className="flex w-full items-center justify-start gap-6 border-b pb-2.5">
        <Skeleton className="h-4 w-16 rounded-md" />
        <Skeleton className="h-4 w-16 rounded-md" />
        <Skeleton className="h-4 w-16 rounded-md" />
      </div>
    </div>
  );
}
