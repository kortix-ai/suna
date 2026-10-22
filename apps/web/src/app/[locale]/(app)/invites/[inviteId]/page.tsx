'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import {
  AuthPendingScreen,
  DetailPanel,
  DetailRow,
  OutcomeTitle,
} from '@kortix/ui/internal/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { inviteLandingPath } from '@kortix/ui/workspace/project-selector/project-selector-model';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
import { authRedirectUrl } from '@kortix/ui/internal/lib/desktop';
import { PROJECT_LANDING_PATH } from '@kortix/ui/internal/lib/onboarding/landing-destination';
import { useAppHome } from '@kortix/ui/internal/lib/onboarding/use-app-home';
import {
  acceptAccountInviteAndLand,
  accountInviteLanding,
  declineAccountInvite,
  describeAccountInvite,
  type AccountInviteDescribe,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

type UnifiedInvite = { kind: 'account'; invite: AccountInviteDescribe };

/** Nothing to subscribe to — the cookie is read fresh on every render. */
const subscribeToNothing = () => () => {};

async function getUnifiedInvite(inviteId: string): Promise<UnifiedInvite> {
  return { kind: 'account', invite: await describeAccountInvite(inviteId) };
}

export default function InvitePage() {
  const appHome = useAppHome();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const locale = useLocale();
  const { inviteId } = useParams<{ inviteId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  // `appHome` comes from a cookie, so the server cannot know it. The third
  // argument is the *server* snapshot, so the first render matches the server's
  // and the anchor picks up the remembered project right after hydration —
  // putting `appHome` straight into an `href` would desync the two renders.
  const homeHref = useSyncExternalStore(
    subscribeToNothing,
    () => appHome,
    () => PROJECT_LANDING_PATH,
  );

  // Not logged in → send through /auth with a return-to so they come back
  // here after sign-in/up. New users can have account/workspace invites
  // auto-claimed on first authenticated account resolution, so this page also
  // handles already-accepted invite rows by routing into the right surface.
  useEffect(() => {
    if (!authLoading && !user) {
      const returnUrl = encodeURIComponent(`/invites/${inviteId}`);
      router.replace(`/auth?returnUrl=${returnUrl}`);
    }
  }, [authLoading, user, inviteId, router]);

  const inviteQuery = useQuery({
    queryKey: ['invite', inviteId],
    queryFn: () => getUnifiedInvite(inviteId!),
    enabled: !!user && !!inviteId,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const current = inviteQuery.data;
      if (!current) throw new Error('Invite is still loading');
      // Only the addressee's description names projects; a redacted one has none.
      return acceptAccountInviteAndLand(
        inviteId!,
        current.invite.email_matches_caller ? current.invite : null,
      );
    },
    onSuccess: async ({ landing }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.accounts.scope() }),
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() }),
      ]);
      // Land a newly-joined member in the project the invite granted, or in the
      // account they just joined. The plain door reopened the project this
      // browser remembered, in the account they came from (KRTX-1731).
      router.replace(inviteLandingPath(landing));
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      const current = inviteQuery.data;
      if (!current) throw new Error('Invite is still loading');
      await declineAccountInvite(inviteId!);
      return { kind: 'account' as const };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
      // `/accounts` was a page; it is a modal (`?accountId=`) now, and a
      // declined invite is not a reason to open it. The landing door is where
      // a signed-in user with nothing else to do belongs.
      router.replace(PROJECT_LANDING_PATH);
    },
  });

  // A directory invite on an instance that cannot prove the address: the
  // account's own IdP can. Found by provider id, because the address's domain
  // may not be the IdP's (a guest from another company).
  const ssoMutation = useMutation({
    mutationFn: async (providerId: string) => {
      const callback = `/auth/callback?${new URLSearchParams({ returnUrl: `/invites/${inviteId}` })}`;
      const { data, error } = await createBrowserSupabaseClient().auth.signInWithSSO({
        providerId,
        options: { redirectTo: authRedirectUrl(callback), skipBrowserRedirect: true },
      });
      if (error || !data?.url) throw error ?? new Error('Single sign-on is not available.');
      window.location.href = data.url;
    },
  });

  useEffect(() => {
    const item = inviteQuery.data;
    const inv = item?.invite;
    // Only auto-redirect the actual recipient. Strangers with a link hit the
    // "wrong account" state instead. Auto-claimed invites (already accepted on
    // first sign-in) use the same destination as a manual accept.
    if (!item || !inv?.email_matches_caller || !inv.accepted_at) return;
    router.replace(inviteLandingPath(accountInviteLanding({ account_id: inv.account_id }, inv)));
  }, [inviteQuery.data, router]);

  if (authLoading || !user || inviteQuery.isLoading) {
    return <AuthPendingScreen footer={false} />;
  }

  if (inviteQuery.error) {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={
              <OutcomeTitle tone="muted">
                {tHardcodedUi.raw('appInvitesInviteidPage.line98JsxTextInviteNotFound')}
              </OutcomeTitle>
            }
            description={tHardcodedUi.raw('appInvitesInviteidPage.inviteInvalidOrRevoked')}
          />
        </Rise>
        <Rise delay={0.06}>
          <HomeAction href={homeHref}>
            {tHardcodedUi.raw('appInvitesInviteidPage.line105JsxTextBackToProjects')}
          </HomeAction>
        </Rise>
      </AuthFrame>
    );
  }

  const item = inviteQuery.data;
  if (!item) return null;
  const invite = item.invite;

  // Wrong-account check first: the server redacts identifying fields in this
  // case, and checking expiry before this would leak "this invite exists and
  // expired" to someone who shouldn't know it exists at all.
  // The caller holds the address, but this instance cannot prove it (no email
  // provider) and nobody shared the invite: the directory pushed it.
  if (!invite.email_matches_caller && invite.reason === 'email_unconfirmed') {
    const providerId = invite.sso_provider_id;
    const ssoError = ssoMutation.error instanceof Error ? ssoMutation.error.message : null;
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={
              providerId
                ? tHardcodedUi.raw('appInvitesInviteidPage.ssoTitle')
                : tHardcodedUi.raw('appInvitesInviteidPage.askAdminTitle')
            }
            description={
              providerId
                ? tHardcodedUi.raw('appInvitesInviteidPage.ssoDescription')
                : tHardcodedUi.raw('appInvitesInviteidPage.askAdminDescription')
            }
          />
        </Rise>
        <Rise delay={0.06} className="space-y-3">
          {ssoError ? <ErrorStrip message={ssoError} /> : null}
          {providerId ? (
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={() => ssoMutation.mutate(providerId)}
              disabled={ssoMutation.isPending}
              aria-busy={ssoMutation.isPending || undefined}
            >
              {ssoMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tHardcodedUi.raw('appInvitesInviteidPage.ssoContinue')}
            </Button>
          ) : null}
          <HomeAction href={homeHref}>
            {tHardcodedUi.raw('appInvitesInviteidPage.line132JsxTextBackToProjects')}
          </HomeAction>
        </Rise>
      </AuthFrame>
    );
  }

  if (!invite.email_matches_caller) {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={tHardcodedUi.raw('appInvitesInviteidPage.line123JsxTextSwitchAccounts')}
            description={
              invite.reason === 'sso_email_domain_unverified' ? (
                tHardcodedUi.raw('appInvitesInviteidPage.ssoDomainUnverified')
              ) : (
                <>
                  {tHardcodedUi.raw(
                    'appInvitesInviteidPage.line125JsxTextThisInviteIsAddressedToADifferentAccount',
                  )}{' '}
                  <span className="text-foreground font-medium wrap-break-word">{user.email}</span>.{' '}
                  {tHardcodedUi.raw('appInvitesInviteidPage.line129JsxTextSignOutAndSignBackInWithThe')}
                </>
              )
            }
          />
        </Rise>
        <Rise delay={0.06} className="space-y-3">
          {/* Sign-in comes back to this invite (KRTX-1731): a manual sign-out
              used to drop the return path. */}
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => void performSignOut({ returnUrl: `/invites/${inviteId}` })}
          >
            {tHardcodedUi.raw('appInvitesInviteidPage.signOutAndContinue')}
          </Button>
          <HomeAction href={homeHref}>
            {tHardcodedUi.raw('appInvitesInviteidPage.line132JsxTextBackToProjects')}
          </HomeAction>
        </Rise>
      </AuthFrame>
    );
  }

  if (invite.expired) {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={
              <OutcomeTitle tone="muted">
                {tHardcodedUi.raw('appInvitesInviteidPage.line143JsxTextInviteExpired')}
              </OutcomeTitle>
            }
            description={
              <>
                {tHardcodedUi.raw('appInvitesInviteidPage.expiredPrefix')}{' '}
                <span className="text-foreground">{formatWhen(invite.expires_at, locale)}</span>
                {tHardcodedUi.raw(
                  'appInvitesInviteidPage.line145JsxTextAskThePersonWhoInvitedYouToSend',
                )}
              </>
            }
          />
        </Rise>
        <Rise delay={0.06}>
          <HomeAction href={homeHref}>
            {tHardcodedUi.raw('appInvitesInviteidPage.line148JsxTextBackToProjects')}
          </HomeAction>
        </Rise>
      </AuthFrame>
    );
  }

  const acceptPending = acceptMutation.isPending;
  const declinePending = declineMutation.isPending;
  const anyPending = acceptPending || declinePending;
  const errorMessage =
    (acceptMutation.error instanceof Error && acceptMutation.error.message) ||
    (declineMutation.error instanceof Error && declineMutation.error.message) ||
    null;
  // A project invite names its project and project role (KRTX-1731); the page
  // used to say "join a team" for it.
  const invitedProject = invite.projects?.[0] ?? null;
  const targetName = invitedProject?.name || item.invite.account_name || 'Account';
  const inviterEmail = invite.inviter_email;
  const targetLabel = invitedProject
    ? tHardcodedUi.raw('appInvitesInviteidPage.projectLabel')
    : tHardcodedUi.raw('appInvitesInviteidPage.teamAccountLabel');
  const roleLabel =
    item.invite.initial_role === 'admin'
      ? tHardcodedUi.raw('appInvitesInviteidPage.roleAdmin')
      : tHardcodedUi.raw('appInvitesInviteidPage.roleMember');
  const projectRoleLabel =
    invitedProject?.role === 'manager'
      ? tHardcodedUi.raw('appInvitesInviteidPage.roleManager')
      : tHardcodedUi.raw('appInvitesInviteidPage.roleMember');

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          mark={inviterEmail ? <UserAvatar email={inviterEmail} size="lg" /> : undefined}
          title={
            inviterEmail ? (
              <>
                <span className="wrap-break-word">{inviterEmail}</span>{' '}
                <span className="text-muted-foreground">
                  {invitedProject
                    ? tHardcodedUi.raw('appInvitesInviteidPage.invitedYouToAProject')
                    : tHardcodedUi.raw(
                        'appInvitesInviteidPage.line180JsxTextInvitedYouToJoinATeam',
                      )}
                </span>
              </>
            ) : invitedProject ? (
              tHardcodedUi.raw('appInvitesInviteidPage.youHaveBeenInvitedToAProject')
            ) : (
              tHardcodedUi.raw('appInvitesInviteidPage.line186JsxTextYouHaveBeenInvitedToJoinATeam')
            )
          }
          description={
            invitedProject
              ? tHardcodedUi('appInvitesInviteidPage.joinProjectDescription', {
                  projectName: invitedProject.name,
                  roleLabel: projectRoleLabel,
                })
              : tHardcodedUi('appInvitesInviteidPage.joinAccountDescription', { roleLabel })
          }
        />
      </Rise>

      <Rise delay={0.06} className="space-y-5">
        <DetailPanel>
          <DetailRow label={targetLabel} value={targetName} />
          <DetailRow
            label={tHardcodedUi.raw('i18nComplete.textf6725f3af08a')}
            value={formatWhen(invite.expires_at, locale)}
          />
        </DetailPanel>

        {errorMessage ? <ErrorStrip message={errorMessage} /> : null}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => declineMutation.mutate()}
            disabled={anyPending}
            aria-busy={declinePending || undefined}
            className="flex-1"
          >
            {declinePending ? <Loading className="size-4 shrink-0" /> : null}
            {tHardcodedUi.raw('appInvitesInviteidPage.decline')}
          </Button>
          <Button
            type="button"
            size="lg"
            onClick={() => acceptMutation.mutate()}
            disabled={anyPending}
            aria-busy={acceptPending || undefined}
            className="flex-1"
          >
            {acceptPending ? <Loading className="size-4 shrink-0" /> : null}
            {tHardcodedUi.raw('appInvitesInviteidPage.accept')}
          </Button>
        </div>
      </Rise>
    </AuthFrame>
  );
}

/** The way out of a terminal invite state. `replace` keeps the old `router.replace` history. */
function HomeAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild size="lg" variant="secondary" className="w-full">
      <Link href={href} replace prefetch>
        {children}
      </Link>
    </Button>
  );
}

const dateFormattersByLocale = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(locale: string): Intl.DateTimeFormat {
  let formatter = dateFormattersByLocale.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale);
    dateFormattersByLocale.set(locale, formatter);
  }
  return formatter;
}

function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((d.getTime() - now.getTime()) / msPerDay);
  if (diffDays < -1) return dateFormatterFor(locale).format(d);
  if (diffDays < 14) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diffDays, 'day');
  }
  return dateFormatterFor(locale).format(d);
}
