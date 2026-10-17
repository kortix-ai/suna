/**
 * Invite — `/invites/<id>` (KRTX-1731), the mobile twin of web's invite page
 * (apps/web/src/app/[locale]/(app)/invites/[inviteId]/page.tsx).
 *
 * Reached from the start screen (a pending invite, or an invite link opened
 * before sign-in — `takeInviteLink`), from a `kortix://invites/<id>` link, and
 * from the switcher sheet's Invites group.
 *
 * States: loading; not found or not loaded; addressed to another account
 * (Sign out and continue: sign-in comes back here); expired; already accepted
 * (lands at once); pending (Accept invite · Decline invite · Not now).
 *
 * Accept lands where every host does (`accountInviteLanding` in the SDK): the
 * invited project, else the joined account's first project, else its project
 * list. The account list is refetched first: the kept list predates the join,
 * and the Projects page resets a selection it does not list. The landing
 * resets the root stack, so no screen sits under the project.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CommonActions, useNavigation } from 'expo-router/react-navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext, useLanguage } from '@/contexts';
import {
  acceptAccountInviteAndLand,
  accountInviteLanding,
  declineAccountInvite,
  type AccountInviteLanding,
} from '@/lib/accounts/accounts-client';
import { haptics } from '@/lib/haptics';
import { inviteKeys, useInvite } from '@/lib/invites/hooks';
import { rememberInviteLink, skippedInvites, takeInviteLink } from '@/lib/invites/invite-landing';
import { log } from '@/lib/logger';
import { projectKeys } from '@/lib/projects/hooks';
import { listAccounts, listProjectsForAccount } from '@/lib/projects/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/** The API's own sentence for a refused request (expired, used), else `fallback`. */
function refusal(err: unknown, fallback: string): string {
  const { status, message } = (err ?? {}) as { status?: unknown; message?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string' && message
    ? message
    : fallback;
}

function Message({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  return (
    <View className="w-full max-w-xs items-center">
      <Text variant="large" className="text-center">
        {title}
      </Text>
      {body ? (
        <Text variant="muted" className="mt-2 text-center">
          {body}
        </Text>
      ) : null}
      <View className="mt-6 w-full gap-2">{children}</View>
    </View>
  );
}

export default function InviteScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useLanguage();
  const { user, isAuthenticated, mfaRequired, signOut } = useAuthContext();
  const signedIn = isAuthenticated && !mfaRequired;

  // This screen shows the remembered link, so the start screen must not open
  // it again. Signed out, `AuthProtection` sends the user to /auth and the
  // link waits for the start screen after sign-in.
  React.useEffect(() => {
    if (signedIn) takeInviteLink();
  }, [signedIn]);

  const inviteQuery = useInvite(id, signedIn && !!id);
  const invite = inviteQuery.data;

  // Back where the user came from; with nothing under this screen, the door.
  const leave = React.useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const land = React.useCallback(
    async (landing: AccountInviteLanding) => {
      await queryClient
        .fetchQuery({ queryKey: projectKeys.accounts, queryFn: () => listAccounts(), staleTime: 0 })
        .catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: inviteKeys.mine });
      let projectId: string | null = null;
      if (landing.kind === 'project') {
        projectId = landing.projectId;
        void queryClient.invalidateQueries({ queryKey: projectKeys.projects(landing.accountId) });
      } else {
        const projects = await queryClient
          .fetchQuery({
            queryKey: projectKeys.projects(landing.accountId),
            queryFn: () => listProjectsForAccount(landing.accountId),
            staleTime: 0,
          })
          .catch(() => []);
        projectId = projects[0]?.project_id ?? null;
      }
      useCurrentAccountStore.getState().setSelectedAccountId(landing.accountId);
      log.log(`🚀 invite ${id} → ${projectId ? `/projects/${projectId}` : '/projects'}`);
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [projectId ? { name: 'projects/[id]', params: { id: projectId } } : { name: 'projects/index' }],
        })
      );
    },
    [id, navigation, queryClient]
  );

  // Accepted before (a re-opened link): land at once, as web does.
  const landedRef = React.useRef(false);
  React.useEffect(() => {
    if (!invite?.email_matches_caller || !invite.accepted_at || landedRef.current) return;
    landedRef.current = true;
    void land(accountInviteLanding({ account_id: invite.account_id }, invite));
  }, [invite, land]);

  const accept = useMutation({
    mutationFn: () => acceptAccountInviteAndLand(id, invite?.email_matches_caller ? invite : null),
    onSuccess: ({ landing }) => {
      haptics.success();
      return land(landing);
    },
    onError: (err) => toast.error(refusal(err, t('invites.acceptFailed', 'Could not accept the invite. Try again.'))),
  });

  const decline = useMutation({
    mutationFn: () => declineAccountInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inviteKeys.mine });
      leave();
    },
    onError: (err) => toast.error(refusal(err, t('invites.declineFailed', 'Could not decline the invite. Try again.'))),
  });

  const notNow = React.useCallback(() => {
    skippedInvites.add(id);
    leave();
  }, [id, leave]);

  const [signingOut, setSigningOut] = React.useState(false);
  const signOutAndContinue = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    // Sign-in ends at `/`, which opens this invite again.
    rememberInviteLink(id);
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    if (result?.success) {
      router.replace('/auth');
      return;
    }
    takeInviteLink();
    toast.error(t('auth.signOutFailed', 'Unable to sign out. Check your connection and try again.'));
  }, [id, router, signOut, signingOut, t, toast]);

  const backToProjects = (
    <Button size="lg" variant="secondary" className="rounded-full" onPress={leave}>
      <Text>{t('invites.backToProjects', 'Back to projects')}</Text>
    </Button>
  );

  let content: React.ReactNode;
  if (!signedIn || inviteQuery.isPending || (invite?.email_matches_caller && invite.accepted_at)) {
    content = <KortixLoader />;
  } else if (inviteQuery.isError || !invite) {
    const notFound = (inviteQuery.error as { status?: unknown } | null)?.status === 404;
    content = notFound ? (
      <Message
        title={t('invites.notFoundTitle', 'Invite not found')}
        body={t('invites.notFoundBody', 'This invite link is invalid or has been revoked.')}>
        {backToProjects}
      </Message>
    ) : (
      <Message title={t('invites.loadFailed', 'Could not load the invite')}>
        <Button size="lg" className="rounded-full" onPress={() => inviteQuery.refetch()}>
          <Text>{t('common.retry', 'Try again')}</Text>
        </Button>
        {backToProjects}
      </Message>
    );
  } else if (!invite.email_matches_caller) {
    content = (
      <Message
        title={t('invites.wrongAccountTitle', 'Switch accounts')}
        body={t('invites.wrongAccountBody', {
          defaultValue: "This invite is addressed to a different account. You're signed in as {{email}}.",
          email: user?.email ?? '',
        })}>
        <Button size="lg" className="rounded-full" disabled={signingOut} onPress={signOutAndContinue}>
          <Text>{t('invites.signOutAndContinue', 'Sign out and continue')}</Text>
        </Button>
        {backToProjects}
      </Message>
    );
  } else if (invite.expired) {
    content = (
      <Message
        title={t('invites.expiredTitle', 'Invite expired')}
        body={t('invites.expiredBody', 'Ask the person who invited you to send a new one.')}>
        {backToProjects}
      </Message>
    );
  } else {
    const project = invite.projects?.[0] ?? null;
    const inviter = invite.inviter_email;
    const lead = project
      ? inviter
        ? t('invites.invitedYouToProject', { defaultValue: '{{inviter}} invited you to a project.', inviter })
        : t('invites.invitedToProject', 'You have been invited to a project.')
      : inviter
        ? t('invites.invitedYouToTeam', { defaultValue: '{{inviter}} invited you to join a team.', inviter })
        : t('invites.invitedToTeam', 'You have been invited to join a team.');
    const join = project
      ? t('invites.joinProject', {
          defaultValue: "You'll join {{project}} as {{role}}.",
          project: project.name,
          role: project.role === 'manager' ? t('invites.roleManager', 'a manager') : t('invites.roleMember', 'a member'),
        })
      : t('invites.joinAccount', {
          defaultValue: "You'll join this account as {{role}} and see projects the owner gives you access to.",
          role: invite.initial_role === 'admin' ? t('invites.roleAdmin', 'an admin') : t('invites.roleMember', 'a member'),
        });
    const busy = accept.isPending || decline.isPending;
    content = (
      <Message
        title={project?.name || invite.account_name || t('invites.fallbackTitle', 'Invite')}
        body={`${lead}\n${join}`}>
        <Button size="lg" className="rounded-full" disabled={busy} onPress={() => accept.mutate()}>
          <Text>{accept.isPending ? t('invites.accepting', 'Accepting…') : t('invites.accept', 'Accept invite')}</Text>
        </Button>
        <Button size="lg" variant="secondary" className="rounded-full" disabled={busy} onPress={() => decline.mutate()}>
          <Text>{decline.isPending ? t('invites.declining', 'Declining…') : t('invites.decline', 'Decline invite')}</Text>
        </Button>
        <Button size="lg" variant="ghost" className="rounded-full" disabled={busy} onPress={notNow}>
          <Text>{t('invites.notNow', 'Not now')}</Text>
        </Button>
      </Message>
    );
  }

  return <View className="flex-1 items-center justify-center bg-background px-8">{content}</View>;
}
