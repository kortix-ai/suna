import { cn } from "@/lib/utils";
import { DashboardContent } from "../../../components/dashboard/dashboard-content";
import { BackgroundAALChecker } from "@/components/auth/background-aal-checker";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default async function DashboardPage() {
  return (
    <BackgroundAALChecker>
      <Suspense
        fallback={
          <div className="flex flex-col h-full w-full">
            <div className="flex-1 flex flex-col items-center justify-center px-4">
              <div className={cn(
                "flex flex-col items-center text-center w-full space-y-8",
                "max-w-[850px] sm:max-w-full sm:px-4"
              )}>
                <Skeleton className="h-10 w-40 sm:h-8 sm:w-32" />
                <Skeleton className="h-7 w-56 sm:h-6 sm:w-48" />
                <Skeleton className="w-full h-[100px] rounded-xl sm:h-[80px]" />
                <div className="block sm:hidden lg:block w-full">
                  <Skeleton className="h-20 w-full" />
                </div>
              </div>
            </div>
          </div>
        }
      >
        <DashboardContent />
      </Suspense>
    </BackgroundAALChecker>
  );
}