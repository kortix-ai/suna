/**
 * Navigation Suspense boundary for /accounts/[id].
 *
 * Without this file, the parent boundary at accounts/loading.tsx (the animated
 * KortixHyperLogo splash) covers this segment and every descendant that lacks
 * its own boundary — including groups/[groupId]. That splash is meant for the
 * first cold load of the whole accounts tree, not for what reads to a user as
 * an in-app tab switch (e.g. a project's Members page -> this account's
 * Groups tab). Mirrors the shell accounts/[id]/page.tsx already paints for its
 * own accountQuery.isLoading state, so the handover to the real page has no
 * layout shift.
 */
import { Skeleton } from '@/components/ui/skeleton';

export default function AccountDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl pb-10">
      <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-12">
        <div className="mb-6 space-y-4 lg:mb-0">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-5 w-32 rounded-md" />
          </div>
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        </div>
        <div className="max-w-3xl space-y-4">
          <Skeleton className="h-7 w-40 rounded-md" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[58px] w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
