'use client';

import { Button } from '@/components/ui/button';
import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import Loading from '@/components/ui/loading';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { readLastProjectId, writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { resolveLandingDestination } from '@/lib/onboarding/resolve-landing-destination';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import type { KortixAccount } from '@kortix/sdk';
import { SignOutIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProjectChooser } from './project-chooser';

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
 * network, then resolves last-used -> first behind that paint and swaps the
 * URL to the real `/projects/<id>`. With nothing to open it renders the
 * chooser (`project-chooser.tsx`): pending invites and a create action. It
 * never creates a project on its own.
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
  /** Nothing to open: the chooser, with create permission for the primary account. */
  const [chooser, setChooser] = useState<{ canCreate: boolean } | null>(null);

  useSignedOutRedirect();

  // `retry: 3` is this reader's own budget, kept verbatim: the landing
  // destination is resolved FROM this list, so one transient failure here
  // strands the user on a spinner with nowhere to go.
  const accountsQuery = useAccountsList({ retry: 3 });

  const resolve = useCallback(async (fresh?: KortixAccount[]) => {
    if (resolving.current) return;
    const accounts = fresh ?? accountsQuery.data;
    if (!accounts || accounts.length === 0) return;

    resolving.current = true;
    attempts.current += 1;

    try {
      // Every membership is a candidate, not just the remembered/first one: a
      // stale persisted selection (a team where the user is a plain member
      // with zero grants) used to end here as a false "No workspace yet"
      // while the personal account, in the same list, held their projects.
      const resolution = await resolveLandingDestination({
        accounts,
        selectedAccountId,
        preferredProjectId: readLastProjectId(user?.id),
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

      // No project exists in ANY account. `/projects` is a redirect back to
      // THIS route (Task 21), so bouncing there would loop forever — render
      // the chooser inline instead.
      setChooser({ canCreate: resolution.canCreate });
    } catch (err) {
      // The LAST attempt ends on the "We could not open your project" screen,
      // and a landing that is genuinely stuck must leave a trace.
      if (attempts.current >= MAX_RESOLVE_ATTEMPTS) {
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

  // A loaded, EMPTY account list. `resolve` returns early on it, so without
  // this nothing is ever set and the loading frame stays up forever, with no
  // control — a hard lock on desktop, which has no browser Back. `GET
  // /accounts` bootstraps a personal account or answers 500, so this is rare;
  // the chooser still shows any pending invite, with no create action.
  const noAccounts = accountsQuery.isSuccess && accountsQuery.data.length === 0;
  const shownChooser = chooser ?? (noAccounts ? { canCreate: false } : null);

  if (shownChooser) {
    return (
      <div className="relative">
        <ProjectChooser
          canCreate={shownChooser.canCreate}
          onJoined={({ accountId, destination }) => {
            setSelectedAccountId(accountId);
            if (destination) {
              router.replace(destination);
              return;
            }
            // A workspace invite with no project grant: resolve again against
            // the account list that now includes the joined workspace.
            setChooser(null);
            attempts.current = 0;
            resolving.current = false;
            void accountsQuery.refetch().then(({ data }) => resolve(data));
          }}
        />
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

  return <ProjectStartLoadingFrame />;
}

/**
 * The error state used to be a dead end: no app chrome renders here, so a
 * user parked on it had no way to sign out and try another account.
 * `performSignOut` clears every piece of persisted client state and then
 * leaves on a document load. The chooser carries its own Log out row, the
 * last row of its panel, the same as the sidebar menu.
 */
function StartSignOutButton() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [pending, setPending] = useState(false);

  // `kx-desktop-band-row` moves the button below the title-bar band on
  // desktop: Win/Linux draws min/max/close over this corner at z 100. The row
  // spans the window, so it passes clicks through and only the button takes
  // them.
  return (
    <div className="kx-desktop-band-row pointer-events-none absolute inset-x-0 top-4 flex justify-end px-4 sm:top-6 sm:px-6">
      <Button
        variant="outline"
        size="sm"
        className="pointer-events-auto gap-1.5 rounded-full"
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
        {tI18nComplete.raw('text49616145514e')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <p className="text-base font-medium">{tI18nComplete.raw('text68e8259bdf2a')}</p>
        <p className="text-muted-foreground text-sm">{tI18nComplete.raw('text4a5e6b5db2ba')}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onRetry}>{tI18nComplete.raw('textd8b8392e2c54')}</Button>
        <Button variant="secondary" asChild>
          <Link href="/new">{tI18nComplete.raw('text954bd1fe66b4')}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The first frame.
 *
 * This used to be a skeleton of the project page — header bar, title, composer,
 * chips. It was a guess: this route never renders that page, it resolves a
 * project id and replaces the URL with `/projects/<id>`, so the skeleton only
 * ever flashed a layout the user was not about to receive.
 *
 * `ProjectPendingScreen` is shared with `loading.tsx` above and with
 * `ProjectAccessBoundary` on the far side of the redirect, so the whole
 * open-a-project path paints one frame instead of three different ones.
 */
function ProjectStartLoadingFrame() {
  return <ProjectPendingScreen />;
}
