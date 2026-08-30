'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { isSigningOut } from '@/lib/auth/sign-out-sequence';
import { SignOutIcon } from '@phosphor-icons/react';
import {
  clearAutoProjectSuppression,
  isAutoProjectSuppressed,
  isProvisionInFlightError,
  navigationMayCreateProject,
} from '@/lib/onboarding/ensure-first-project';
import { readLastProjectId, writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { resolveLandingDestination } from '@/lib/onboarding/resolve-landing-destination';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { classifyLandingTerminal, ProjectStartEmpty } from './landing-terminal';

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
  const setSelectedAccountId = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const attempts = useRef(0);
  const resolving = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [failed, setFailed] = useState(false);
  const [terminal, setTerminal] = useState<ReturnType<typeof classifyLandingTerminal> | null>(
    null,
  );

  // `isSigningOut()` first: `StartSignOutButton` below is rendered by this same
  // page, and `performSignOut` fires `SIGNED_OUT` before its document load
  // starts. Without this the guard wins that race and the user reaches `/auth`
  // by SOFT navigation, carrying the App Router route cache across the identity
  // change — the defect the hard navigation exists to remove.
  useEffect(() => {
    if (isSigningOut()) return;
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // The guard has done its one job the moment this surface renders: the user
  // has now been TOLD their last workspace is gone and offered a way back
  // (below). Leaving the flag set past this point would silently block
  // auto-provision for the next account this tab visits that happens to be
  // empty too — it's a single process-wide sessionStorage key, not scoped to
  // the account that triggered it. Session-scoped by design (see
  // ensure-first-project.ts): a later sign-in or a fresh tab still
  // auto-provisions normally, clear or not.
  useEffect(() => {
    if (terminal === 'suppressed') clearAutoProjectSuppression();
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
    if (!accounts || accounts.length === 0) return;

    resolving.current = true;
    attempts.current += 1;

    const suppressed = isAutoProjectSuppressed();

    try {
      // Every membership is a candidate, not just the remembered/first one: a
      // stale persisted selection (a team where the user is a plain member
      // with zero grants) used to end here as a false "No workspace yet"
      // while the personal account, in the same list, held their projects.
      const resolution = await resolveLandingDestination({
        accounts,
        selectedAccountId,
        preferredProjectId: readLastProjectId(user?.id),
        suppressed,
        mayCreate: navigationMayCreateProject(),
      });

      if (resolution.kind === 'project') {
        const { project } = resolution;
        // Heal the persisted selection: every account-scoped surface after
        // this navigation must agree with where the user actually landed.
        setSelectedAccountId(resolution.accountId);
        writeLastProjectId(user?.id, project.project_id);
        router.replace(withCurrentQuery(`/projects/${project.project_id}`));
        return;
      }

      // No project exists in ANY account and the primary candidate account
      // may not create one: a member workspace context (flow 08's revoked
      // member), the account the user just emptied by deleting their last
      // project, or the rare cross-site-navigation edge. `/projects` is a
      // redirect back to THIS route (Task 21), so bouncing there would loop
      // forever — render the terminal state inline instead.
      setTerminal(classifyLandingTerminal({ canCreate: resolution.canCreate, suppressed }));
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
        retryTimer.current = setTimeout(() => {
          resolving.current = false;
          void resolve();
        }, delay);
        return;
      }
      setFailed(true);
    } finally {
      if (attempts.current >= MAX_RESOLVE_ATTEMPTS) resolving.current = false;
    }
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId, router, user?.id]);

  useEffect(() => {
    if (attempts.current > 0) return;
    void resolve();
  }, [resolve]);

  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  if (terminal) {
    return (
      <div className="relative">
        <StartSignOutButton />
        <ProjectStartEmpty reason={terminal} />
      </div>
    );
  }

  if (failed || accountsQuery.isError) {
    return (
      <div className="relative">
        <StartSignOutButton />
        <ProjectStartError
          onRetry={() => {
            attempts.current = 0;
            resolving.current = false;
            setFailed(false);
            if (accountsQuery.isError) void accountsQuery.refetch();
            else void resolve();
          }}
        />
      </div>
    );
  }

  return <ProjectStartSkeleton />;
}

/**
 * Both stuck states on this route (terminal and error) used to be dead ends:
 * no app chrome renders here, so a user parked on "No workspace yet" had no
 * way to sign out and try another account. `performSignOut` clears every piece
 * of persisted client state — including the stale account selection that used
 * to cause the false terminal — and then leaves on a document load.
 *
 * Deliberately OUTSIDE `ProjectStartEmpty`: the no-permission case pins "no
 * <a>/<button> in the empty surface" (landing-terminal.test.tsx), and that
 * contract is about create controls that would 403 — not about this exit.
 */
function StartSignOutButton() {
  const [pending, setPending] = useState(false);

  return (
    <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 rounded-full"
        disabled={pending}
        onClick={() => {
          setPending(true);
          // `performSignOut` owns the navigation and ends it on a DOCUMENT
          // load, so there is nothing to prefetch and nothing to push: a soft
          // transition would carry this account's route cache into the next
          // one's session. `pending` is never cleared because the document is
          // replaced, not re-rendered.
          void performSignOut();
        }}
      >
        {pending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <SignOutIcon className="size-4 shrink-0" />
        )}
        Log out
      </Button>
    </div>
  );
}

/**
 * Failure stays on this route. Falling back to `/projects` would quietly make
 * the list the default destination again, which is exactly what this flow
 * removes — so the recovery is an explicit retry, and the secondary action
 * goes to `/new`, not `/projects`: the list is gone (Task 21), and `/projects`
 * is now a redirect back to THIS route, which would just re-run the same
 * failing resolve a beat later instead of offering anything new.
 */
function ProjectStartError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <p className="text-base font-medium">We could not open your project</p>
        <p className="text-muted-foreground text-sm">
          Something went wrong on our side. Your work is safe.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" asChild>
          <Link href="/new">Create a workspace</Link>
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
