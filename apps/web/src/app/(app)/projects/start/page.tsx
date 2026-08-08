'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import {
  ensureFirstProject,
  isAutoProjectSuppressed,
  isProvisionInFlightError,
  navigationMayCreateProject,
} from '@/lib/onboarding/ensure-first-project';
import { readLastProjectId, writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Carry the incoming query string onto the resolved destination.
 *
 * This door is a redirect, not a page, so anything deep-linked to it has to
 * survive the hop. Concretely: a Stripe `success_url` can target the door when
 * the browser has no remembered project yet, and dropping `?team_signup=success`
 * here would silently swallow the post-checkout refresh and celebration.
 */
function withCurrentQuery(path: string): string {
  if (typeof window === 'undefined') return path;
  const { search } = window.location;
  return search && search !== '?' ? `${path}${search}` : path;
}

/** Transient failures get retried here rather than bounced to the list. */
const MAX_RESOLVE_ATTEMPTS = 3;
const RETRY_DELAY_MS = [400, 1200];

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
  const attempts = useRef(0);
  const resolving = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
    retry: 3,
  });

  const resolve = useCallback(async () => {
    if (resolving.current) return;
    const accounts = accountsQuery.data;
    if (!accounts) return;

    const account =
      accounts.find((entry) => entry.account_id === selectedAccountId) ?? accounts[0] ?? null;
    if (!account) return;

    resolving.current = true;
    attempts.current += 1;

    // Only owners/admins may create a project (ACCOUNT_ACTIONS.PROJECT_CREATE).
    const canCreate = account.account_role === 'owner' || account.account_role === 'admin';

    try {
      const project = await ensureFirstProject(account.account_id, {
        preferredProjectId: readLastProjectId(user?.id),
        allowCreate: canCreate && !isAutoProjectSuppressed() && navigationMayCreateProject(),
      });

      if (project) {
        writeLastProjectId(user?.id, project.project_id);
        router.replace(withCurrentQuery(`/workspaces/${project.project_id}`));
        return;
      }

      // No project exists AND none may be created here: a member without
      // PROJECT_CREATE, or the account the user just emptied by deleting their
      // last project. There is no project to open, so the list is the only
      // surface that can explain the state — this is a terminal case, not a
      // default landing.
      router.replace(withCurrentQuery('/workspaces'));
    } catch (err) {
      // A concurrent, healthy provision — this account's OTHER tab or entry
      // point is mid-create with the same persisted idempotency key — is not
      // a bug. `ensureFirstProject` already re-checked once before throwing;
      // this loop's own retry (below, same key) is what waits out the rest,
      // so this must not be logged as though something went wrong.
      //
      // The LAST attempt is different: it ends on the "We could not open your
      // project" screen, and an onboarding that is genuinely stuck must leave
      // a trace. Silence there is the one state that produces a support ticket
      // with nothing to read.
      if (!isProvisionInFlightError(err) || attempts.current >= MAX_RESOLVE_ATTEMPTS) {
        console.error('[onboarding] could not resolve a landing project', err);
      }
      const delay = RETRY_DELAY_MS[attempts.current - 1];
      if (attempts.current < MAX_RESOLVE_ATTEMPTS && delay !== undefined) {
        // A transient backend hiccup must not demote the user to the projects
        // list — retry in place, behind the same paint.
        setTimeout(() => {
          resolving.current = false;
          void resolve();
        }, delay);
        return;
      }
      setFailed(true);
    } finally {
      if (attempts.current >= MAX_RESOLVE_ATTEMPTS) resolving.current = false;
    }
  }, [accountsQuery.data, selectedAccountId, router, user?.id]);

  useEffect(() => {
    if (attempts.current > 0) return;
    void resolve();
  }, [resolve]);

  if (failed || accountsQuery.isError) {
    return (
      <ProjectStartError
        onRetry={() => {
          attempts.current = 0;
          resolving.current = false;
          setFailed(false);
          if (accountsQuery.isError) void accountsQuery.refetch();
          else void resolve();
        }}
      />
    );
  }

  return <ProjectStartSkeleton />;
}

/**
 * Failure stays on this route. Falling back to `/projects` would quietly make
 * the list the default destination again, which is exactly what this flow
 * removes — so the recovery is an explicit retry, and the list is offered only
 * as a deliberate choice.
 */
function ProjectStartError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <p className="text-base font-medium">We could not open your workspace</p>
        <p className="text-muted-foreground text-sm">
          Something went wrong on our side. Your work is safe.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="ghost" asChild>
          <Link href="/workspaces">View all workspaces</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The first frame. Shaped like the project page it is about to become — header
 * bar, title, composer — so the swap to `/projects/<id>` reads as the page
 * filling in rather than as a second navigation.
 */
function ProjectStartSkeleton() {
  return (
    <div className="flex min-h-screen flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Opening your workspace</span>
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
