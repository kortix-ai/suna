'use client';

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { joinDestination } from '@/features/workspace/project-selector/project-selector-model';
import { useMyInvites } from '@/hooks/account/use-my-invites';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { acceptAccountInvite, type MyAccountInvite } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

/**
 * Pending invites at the top of the Switch Project menu. A user who already
 * has a project lands in it, not on the chooser, so this is where an invite
 * that arrives later is found. Renders nothing when there are none.
 */
export function InvitationsMenuGroup() {
  const t = useTranslations('projectChooser');
  const router = useRouter();
  const queryClient = useQueryClient();
  const setSelectedAccountId = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const invitesQuery = useMyInvites();
  const invites = invitesQuery.data ?? [];

  const join = useMutation({
    mutationFn: (invite: MyAccountInvite) => acceptAccountInvite(invite.invite_id),
    onSuccess: async (_result, invite) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.accounts.scope() }),
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() }),
      ]);
      setSelectedAccountId(invite.account_id);
      router.push(joinDestination(invite) ?? PROJECT_LANDING_PATH);
    },
    onError: (error: unknown) => {
      errorToast(error instanceof Error ? error.message : t('joinError'));
    },
  });

  if (invites.length === 0) return null;

  return (
    <>
      <DropdownMenuGroup className="p-0.5" data-testid="switcher-invitations">
        <DropdownMenuLabel className="px-1.5 text-sm">
          {t('invitations')} · {invites.length}
        </DropdownMenuLabel>
        {invites.map((invite) => {
          const workspace = invite.account_name ?? t('unnamedWorkspace');
          const title =
            invite.projects.length > 0 ? invite.projects.map((p) => p.name).join(', ') : workspace;
          const joining = join.isPending && join.variables?.invite_id === invite.invite_id;
          return (
            <DropdownMenuItem
              key={invite.invite_id}
              className="cursor-pointer px-1.5"
              disabled={join.isPending}
              // Keep the menu open while the join runs; navigation closes it.
              onSelect={(event) => {
                event.preventDefault();
                join.mutate(invite);
              }}
            >
              <EntityAvatar label={title} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
              {joining ? (
                <Loading className="text-muted-foreground size-3.5" />
              ) : (
                <span className="text-muted-foreground text-xs">{t('join')}</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}
