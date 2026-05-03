import { Suspense } from "react";
import { BackgroundAALChecker } from "@/components/auth/background-aal-checker";
import { ProjectsDashboard } from "@/components/dashboard/projects-dashboard";
import { Skeleton } from "@/components/ui/skeleton";

function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="mt-6 flex gap-2">
        <Skeleton className="h-9 w-72" />
        <div className="ml-auto">
          <Skeleton className="h-9 w-56" />
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[160px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  return (
    <BackgroundAALChecker>
      <Suspense fallback={<DashboardSkeleton />}>
        <ProjectsDashboard />
      </Suspense>
    </BackgroundAALChecker>
  );
}
