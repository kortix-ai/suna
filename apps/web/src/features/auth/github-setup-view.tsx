'use client';

/**
 * What the GitHub setup page shows (`/github/setup`), as a function of its
 * state. No fetching and no GitHub popup here, so every state renders on
 * `/debug/consent/github-setup` without a real installation.
 */

import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { DetailPanel, DetailRow, OutcomeTitle } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { Github } from '@/features/icon/icons/github';
import type { LinkableGitHubInstallation } from '@kortix/sdk';

export type GitHubSetupState =
  'verify' | 'loading' | 'select' | 'empty' | 'saving' | 'done' | 'error';

export function GitHubSetupView({
  state,
  message,
  setupAction,
  selectingExistingInstallation,
  email,
  installations,
  installUrl,
  backHref,
  returnPath,
  onVerify,
  onLink,
  onBack,
}: {
  state: GitHubSetupState;
  message: string;
  /** GitHub's `setup_action` query value; `uninstall` changes the done heading. */
  setupAction: string;
  selectingExistingInstallation: boolean;
  email: string | null;
  installations: LinkableGitHubInstallation[];
  installUrl: string | null;
  /** Where Back goes: the page that opened this flow, else the app home. */
  backHref: string;
  /** The page that opened this flow, when one was remembered. */
  returnPath: string | null;
  onVerify: () => void;
  onLink: (installation: LinkableGitHubInstallation) => void;
  /** Runs on a Back click, before the navigation. */
  onBack: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const heading = getHeading(state, setupAction, selectingExistingInstallation);

  // The live region wraps only the status content — not the frame — so
  // screen readers don't re-announce the mark and legal footer on updates.
  // Desktop Back returns to the page that opened this flow, like the in-page
  // Back below. The account hub opens it with router.replace, so history alone
  // would skip the hub's Git tab.
  const account = (
    <DetailPanel>
      <DetailRow label={tI18nComplete.raw('text7e1b0d5641f2')} value={email ?? 'You'} />
    </DetailPanel>
  );

  return (
    <AuthFrame backHref={returnPath ?? undefined}>
      <div role="status" aria-live="polite" aria-label={heading}>
        <Rise>
          <StepHeader
            title={
              state === 'done' ? (
                <OutcomeTitle tone={setupAction === 'uninstall' ? 'muted' : 'success'}>
                  {heading}
                </OutcomeTitle>
              ) : (
                heading
              )
            }
            description={message}
          />
        </Rise>
        {state === 'verify' ? (
          <Rise delay={0.06}>
            {account}
            {/* No GitHub mark on the button: the title and the label both say
                GitHub already. */}
            <Button size="lg" className="mt-5 w-full" onClick={onVerify}>
              {selectingExistingInstallation
                ? tI18nComplete.raw('text7b9db77e0178')
                : tI18nComplete.raw('text8130db25eca7')}
            </Button>
          </Rise>
        ) : state === 'saving' ? (
          // The verify layout, held: the account stays where it was and the
          // button stays in place, disabled, with the session busy mark. Its
          // label is the action that is running.
          <Rise delay={0.06}>
            {account}
            <Button size="lg" className="mt-5 w-full" disabled>
              <SessionDotMatrix size={14} className="shrink-0" />
              {selectingExistingInstallation ? tI18nComplete.raw('texta6a32dbc5618') : tI18nComplete.raw('text8130db25eca7')}
            </Button>
            <span className="sr-only">{tI18nComplete.raw('text147251df4759')}</span>
          </Rise>
        ) : state === 'loading' ? (
          // The shape of the account list that is coming.
          <Rise delay={0.06}>
            <ul aria-hidden className="border-border divide-border/60 divide-y rounded-md border">
              {[0, 1, 2].map((row) => (
                <li key={row} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Skeleton className="size-9 shrink-0 rounded-sm py-0" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-32 py-0" />
                    <Skeleton className="h-3 w-44 py-0" />
                  </div>
                  <Skeleton className="h-8 w-14 py-0" />
                </li>
              ))}
            </ul>
            <span className="sr-only">{tI18nComplete.raw('text147251df4759')}</span>
          </Rise>
        ) : state === 'select' ? (
          // One panel with divided rows, the same shape as the detail panel on
          // the other consent screens: the mark, the account and what it
          // covers, then the one action.
          <Rise delay={0.06}>
            <ul className="border-border divide-border/60 divide-y rounded-md border">
              {installations.map((installation) => (
                <li
                  key={installation.installation_id}
                  className="flex items-center gap-3 px-3.5 py-2.5"
                >
                  <span className="bg-secondary text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
                    <Github className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {installation.owner_login ?? tI18nComplete.raw('textd686f873a566')}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {installation.owner_type === 'User' ? 'Personal' : 'Organization'}
                      {installation.repository_selection ? (
                        <>
                          <span aria-hidden className="text-muted-foreground/40">
                            {' \u2022 '}
                          </span>
                          {installation.repository_selection === 'all'
                            ? tI18nComplete.raw('text77fe4eba38d8')
                            : tI18nComplete.raw('texte0a8d25fe959')}
                        </>
                      ) : null}
                    </p>
                    {/* One GitHub installation can back several Kortix
                        accounts. Linking it again is legal, so this is a
                        warning on the row and not a disabled button. */}
                    {installation.linked_to_other_accounts > 0 ? (
                      <p className="text-kortix-orange mt-0.5 text-xs">
                        {tI18nComplete('text0b0e4c425624', {
                          value0: installation.linked_to_other_accounts,
                        })}
                      </p>
                    ) : null}
                  </div>
                  {/* An account already linked here has nothing to press: it
                      says so, and does not offer a dead button. */}
                  {installation.linked ? (
                    <Badge variant="outline" size="sm">
                      {tI18nComplete.raw('textbfda026e6c59')}
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => onLink(installation)}
                    >
                      {tI18nComplete.raw('texta6a32dbc5618')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Rise>
        ) : state === 'empty' ? (
          <Rise delay={0.06}>
            <div className="space-y-3">
              {installUrl ? (
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => window.location.assign(installUrl)}
                >
                  {tI18nComplete.raw('text8d3f36f31348')}
                </Button>
              ) : null}
              <Button size="lg" variant="outline" className="w-full" asChild>
                <Link href={backHref} replace prefetch onClick={onBack}>
                  {tI18nComplete.raw('text76900f1bfd16')}
                </Link>
              </Button>
            </div>
          </Rise>
        ) : state === 'done' ? (
          // The account it was done for stays on screen until the redirect.
          <Rise delay={0.06}>{account}</Rise>
        ) : state === 'error' ? (
          // Back to the page that opened this flow when there is one — a
          // failed link should return the user to the Git tab they started
          // from, not strand them on the app's landing page.
          <Rise delay={0.06}>
            <Button size="lg" className="w-full" asChild>
              <Link href={backHref} replace prefetch onClick={onBack}>
                {returnPath
                  ? tI18nComplete.raw('text76900f1bfd16')
                  : tI18nComplete.raw('text5fae82827f98')}
              </Link>
            </Button>
          </Rise>
        ) : null}
      </div>
    </AuthFrame>
  );
}

function getHeading(
  state: GitHubSetupState,
  setupAction: string,
  selectingExistingInstallation: boolean,
): string {
  switch (state) {
    case 'verify':
      return selectingExistingInstallation ? 'Link a GitHub account' : 'Verify GitHub access';
    case 'loading':
      return 'Loading GitHub accounts';
    case 'select':
      return 'Select a GitHub account';
    case 'empty':
      return 'Install the Kortix App';
    case 'saving':
      return 'Linking GitHub';
    case 'done':
      return setupAction === 'uninstall' ? 'GitHub disconnected' : 'GitHub connected';
    case 'error':
      return 'Could not connect GitHub';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
