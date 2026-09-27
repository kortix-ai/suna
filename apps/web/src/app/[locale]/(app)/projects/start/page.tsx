'use client';

import { Button } from '@/components/ui/button';
import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import Loading from '@/components/ui/loading';
import { useAuth } from '@/features/providers/auth-provider';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { readLastProjectId, writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { SignOutIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { decideDoor } from '@/features/workspace/project-selector/project-selector-model';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';

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

/**
 * `/projects/start` — the id-free door into the product.
 *
 * Every default entry point (post-auth redirect, `/`, the desktop shell) sends
 * the user here when the destination project id is not already known. It
 * paints the project chrome on the first frame with zero network, then asks
 * one question: is there a single obvious project to open?
 *
 *  - the project this browser last had open, if it still exists, or
 *  - the user's only project.
 *
 * Yes: replace the URL with `/projects/<id>`. No — several projects and no
 * memory, no project at all, or a pending invite — replace it with
 * `/projects`, the selector (`decideDoor`). The door never creates a project
 * and never renders a form of its own.
 */
export default function ProjectStartPage() {
  const router = useRouter();
  const { user } = useAuth();
  const setSelectedAccountId = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const data = useProjectSelectorData();
  const decided = useRef<string | null>(null);
  const [nudge, setNudge] = useState(0);

  useSignedOutRedirect();

  const failed = data.accountsQuery.isError || data.allListsFailed;
  // Invites gate the decision: a pending invite always shows the selector. A
  // failed invite read degrades to "no invites" rather than blocking entry.
  const ready = !data.listsLoading && !data.invitesQuery.isLoading && !failed;

  useEffect(() => {
    if (!ready) return;
    if (!decided.current) {
      const decision = decideDoor({
        sections: data.sections,
        inviteCount: data.invites.length,
        rememberedProjectId: readLastProjectId(user?.id),
      });
      if (decision.kind === 'open') {
        // Heal the persisted selection: every account-scoped surface after this
        // navigation must agree with where the user landed.
        setSelectedAccountId(decision.accountId);
        writeLastProjectId(user?.id, decision.projectId);
        decided.current = withCurrentQuery(`/projects/${decision.projectId}`);
      } else {
        decided.current = withCurrentQuery('/projects');
      }
    }
    router.replace(decided.current);
    // A soft navigation can be dropped (a cold dev compile, a superseded
    // transition). This door has no content of its own, so a dropped replace
    // would leave the loading frame up forever. Re-issue the SAME destination
    // until this component unmounts.
    const timer = setTimeout(() => setNudge((n) => n + 1), 3000);
    return () => clearTimeout(timer);
  }, [ready, nudge, data.sections, data.invites.length, user?.id, router, setSelectedAccountId]);

  if (failed) {
    return (
      <div className="relative">
        <StartSignOutButton />
        <ProjectStartError onRetry={data.retryAll} />
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
