'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import {
  clearAutoWorkspaceSuppression,
  ensureFirstWorkspace,
  isAutoWorkspaceSuppressed,
  isProvisionInFlightError,
  navigationMayCreateWorkspace,
} from '@/lib/onboarding/ensure-first-workspace';
import { readLastWorkspaceId, writeLastWorkspaceId } from '@/lib/onboarding/last-workspace-cookie';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { classifyLandingTerminal, WorkspaceStartEmpty } from './landing-terminal';

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
 * `/workspaces/start` — the id-free door into the product.
 *
 * Every default entry point (post-auth redirect, `/`, the desktop shell) sends
 * the user to a workspace. When the destination workspace id is not already known,
 * it sends them here. This route exists so that resolving WHICH project never
 * blocks a redirect: it paints the workspace chrome on the first frame with zero
 * network, then resolves last-used -> first -> auto-provision behind that paint
 * and swaps the URL to the real `/workspaces/<id>`.
 *
 * Before this existed, sign-up awaited a managed git repo create AND a full
 * starter push inside the auth callback, so a new user watched a blank callback
 * page for the entire provision.
 */
export default function WorkspaceStartPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const attempts = useRef(0);
  const resolving = useRef(false);
  const [failed, setFailed] = useState(false);
  const [terminal, setTerminal] = useState<ReturnType<typeof classifyLandingTerminal> | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // The guard has done its one job the moment this surface renders: the user
  // has now been TOLD their last workspace is gone and offered a way back
  // (below). Leaving the flag set past this point would silently block
  // auto-provision for the next account this tab visits that happens to be
  // empty too — it's a single process-wide sessionStorage key, not scoped to
  // the account that triggered it. Session-scoped by design (see
  // ensure-first-workspace.ts): a later sign-in or a fresh tab still
  // auto-provisions normally, clear or not.
  useEffect(() => {
    if (terminal === 'suppressed') clearAutoWorkspaceSuppression();
  }, [terminal]);

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

    // Only owners/admins may create a workspace (ACCOUNT_ACTIONS.WORKSPACE_CREATE).
    const canCreate = account.account_role === 'owner' || account.account_role === 'admin';
    const suppressed = isAutoWorkspaceSuppressed();

    try {
      const workspace = await ensureFirstWorkspace(account.account_id, {
        preferredWorkspaceId: readLastWorkspaceId(user?.id),
        allowCreate: canCreate && !suppressed && navigationMayCreateWorkspace(),
      });

      if (workspace) {
        writeLastWorkspaceId(user?.id, workspace.workspace_id);
        router.replace(withCurrentQuery(`/workspaces/${workspace.workspace_id}`));
        return;
      }

      // No project exists AND none may be created here: a member without
      // WORKSPACE_CREATE, the account the user just emptied by deleting their
      // last project, or the rare cross-site-navigation edge. `/workspaces` is
      // a redirect back to THIS route (Task 21), so bouncing there would
      // loop forever — render the terminal state inline instead.
      setTerminal(classifyLandingTerminal({ canCreate, suppressed }));
    } catch (err) {
      // A concurrent, healthy provision — this account's OTHER tab or entry
      // point is mid-create with the same persisted idempotency key — is not
      // a bug. `ensureFirstWorkspace` already re-checked once before throwing;
      // this loop's own retry (below, same key) is what waits out the rest,
      // so this must not be logged as though something went wrong.
      //
      // The LAST attempt is different: it ends on the "We could not open your
      // project" screen, and an onboarding that is genuinely stuck must leave
      // a trace. Silence there is the one state that produces a support ticket
      // with nothing to read.
      if (!isProvisionInFlightError(err) || attempts.current >= MAX_RESOLVE_ATTEMPTS) {
        console.error('[onboarding] could not resolve a landing workspace', err);
      }
      const delay = RETRY_DELAY_MS[attempts.current - 1];
      if (attempts.current < MAX_RESOLVE_ATTEMPTS && delay !== undefined) {
        // A transient backend hiccup must not demote the user to the workspaces
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

  if (terminal) {
    return <WorkspaceStartEmpty reason={terminal} />;
  }

  if (failed || accountsQuery.isError) {
    return (
      <WorkspaceStartError
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

  return <WorkspaceStartSkeleton />;
}

/**
 * Failure stays on this route. Falling back to `/workspaces` would quietly make
 * the list the default destination again, which is exactly what this flow
 * removes — so the recovery is an explicit retry, and the secondary action
 * goes to `/new`, not `/workspaces`: the list is gone (Task 21), and `/workspaces`
 * is now a redirect back to THIS route, which would just re-run the same
 * failing resolve a beat later instead of offering anything new.
 */
function WorkspaceStartError({ onRetry }: { onRetry: () => void }) {
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
          <Link href="/new">Create a workspace</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The first frame. Shaped like the workspace page it is about to become — header
 * bar, title, composer — so the swap to `/workspaces/<id>` reads as the page
 * filling in rather than as a second navigation.
 */
function WorkspaceStartSkeleton() {
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
