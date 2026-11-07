/**
 * WorkspaceInvitations — the "Invitations" group (Workspaces ux.md §1 and §3):
 * one row per pending invite, first on the create-or-join screen (`app/new.tsx`)
 * and in the workspace switcher (`ProjectSwitcherSheet`). Each row shows the
 * workspace name, the inviter and the role, and "Join". A tap opens the invite
 * screen (`app/invites/[id].tsx`), where Accept lands in the workspace.
 */

import * as React from 'react';
import { View } from 'react-native';

import { Avatar } from '@/components/kortix/avatar';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useLanguage } from '@/contexts';
import type { MyAccountInvite } from '@/lib/accounts/accounts-client';

type Translate = ReturnType<typeof useLanguage>['t'];

/** The role the invite grants, as a bare label: the project grant when it carries one, else the account role. */
export function inviteRoleLabel(invite: Pick<MyAccountInvite, 'initial_role' | 'projects'>, t: Translate): string {
  const role = invite.projects[0]?.role ?? invite.initial_role;
  if (role === 'owner') return t('workspace.roleOwner', 'Owner');
  if (role === 'admin') return t('workspace.roleAdmin', 'Admin');
  if (role === 'manager') return t('workspace.roleManager', 'Manager');
  return t('workspace.roleMember', 'Member');
}

export function WorkspaceInvitations({
  invites,
  onOpenInvite,
  disabled = false,
}: {
  invites: ReadonlyArray<MyAccountInvite>;
  onOpenInvite: (inviteId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  if (invites.length === 0) return null;
  return (
    <View>
      <SettingsGroup title={t('invites.group', 'Invitations')}>
        {invites.map((invite) => {
          const name = invite.projects[0]?.name || invite.account_name || t('invites.fallbackTitle', 'Invite');
          const role = inviteRoleLabel(invite, t);
          const description = invite.inviter_email
            ? t('workspace.inviteFrom', {
                defaultValue: '{{inviter}} · {{role}}',
                inviter: invite.inviter_email,
                role,
              })
            : role;
          return (
            <SettingsRow
              key={invite.invite_id}
              leading={<Avatar chalk size={28} fallbackText={name} />}
              label={name}
              description={description}
              value={t('workspace.join', 'Join')}
              accessibilityLabel={t('workspace.joinNamed', { defaultValue: 'Join {{workspace}}', workspace: name })}
              onPress={disabled ? undefined : () => onOpenInvite(invite.invite_id)}
            />
          );
        })}
      </SettingsGroup>
    </View>
  );
}
