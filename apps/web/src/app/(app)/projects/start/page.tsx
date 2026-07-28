'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { isBillingEnabled } from '@/lib/config';
import { ensureFirstProject, isAutoProjectSuppressed } from '@/lib/onboarding/ensure-first-project';
import { readLastProjectId, writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * `/projects/start` — the id-free door into the product.
 *
 * Every default entry point (post-auth redirect, `/`, the desktop shell) sends
 * the user to a project. When the destination project id is not already known,
 * it sends them here. This route exists so that resolving WHICH project never
 * blocks a redirect: it paints the project chrome on the first frame with zero
 * network, then resolves last-used -> first -> auto-provision behind that paint
 * and swaps the URL to the real `/projects/<id>`.
 *
 * Before this existed, sign-up awaited a managed git repo create AND a full
 * starter push inside the auth callback, so a new user watched a blank callback
 * page for the entire provision.
 */
export default function ProjectStartPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const resolveAttempted = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (resolveAttempted.current) return;
    const accounts = accountsQuery.data;
    if (!accounts) return;

    const account =
      accounts.find((entry) => entry.account_id === selectedAccountId) ?? accounts[0] ?? null;
    if (!account) {
      // No account yet is not a state this route can resolve. The list page owns
      // the account-less empty/error surface.
      router.replace('/projects');
      return;
    }

    resolveAttempted.current = true;

    // Only owners/admins may create a project (ACCOUNT_ACTIONS.PROJECT_CREATE).
    // A member of a team with no projects must land on the list, not on a 403.
    const canCreate = account.account_role === 'owner' || account.account_role === 'admin';

    ensureFirstProject(account.account_id, {
      preferredProjectId: readLastProjectId(),
      allowCreate: canCreate && !isAutoProjectSuppressed(),
    })
      .then((project) => {
        if (!project) {
          router.replace('/projects');
          return;
        }
        writeLastProjectId(project.project_id);
        router.replace(`/projects/${project.project_id}`);
      })
      .catch((err) => {
        // Never strand the user on this route. The list page can show the real
        // error, the create flow, or the billing state as appropriate.
        console.error('[onboarding] could not resolve a landing project', err);
        router.replace('/projects');
      });
  }, [accountsQuery.data, selectedAccountId, router]);

  useEffect(() => {
    if (!accountsQuery.isError) return;
    router.replace('/projects');
  }, [accountsQuery.isError, router]);

  return <ProjectStartSkeleton />;
}

/**
 * The first frame. Shaped like the project page it is about to become — header
 * bar, title, composer — so the swap to `/projects/<id>` reads as the page
 * filling in rather than as a second navigation.
 */
function ProjectStartSkeleton() {
  return (
    <div className="flex min-h-screen flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Opening your project</span>
      <div className="w-full border-b">
        <div className="kx-app-header px-mobile mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-2 py-4 sm:gap-3">
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
      </div>
      <main className="bg-background px-mobile flex flex-1 items-center py-10 sm:py-12">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="space-y-3">
            <Skeleton className="mx-auto h-9 w-64 rounded-md" />
            <Skeleton className="mx-auto h-5 w-96 max-w-full rounded-md" />
          </div>
          <Skeleton className="h-32 w-full rounded-lg" />
          <div className="flex flex-wrap justify-center gap-2">
            <Skeleton className="h-8 w-28 rounded-full" />
            <Skeleton className="h-8 w-36 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
        </div>
      </main>
    </div>
  );
}
