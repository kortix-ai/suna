'use client';

import { leaveWorkspace, listWorkspaceMembers, type AccountMember, type WorkspaceRole } from '@kortix/sdk';
import { qk, useWorkspace } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { PROJECT_LANDING_PATH } from '../../internal/lib/onboarding/landing-destination';
import { forgetLastProjectId } from '../../internal/lib/onboarding/last-project-cookie';
import { useSettingsPanelStore } from '../../internal/stores/settings-panel-store';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { errorToast, successToast } from '../../primitives/toast';
import { useUiRouter, useUiViewerId } from '../../providers/ui-provider';

/** A member row's ladder role: the served `role`, else the account role an older API sends. */
export function memberWorkspaceRole(member: Pick<AccountMember, 'role' | 'account_role'>): WorkspaceRole {
  return member.role ?? member.account_role ?? 'member';
}

/**
 * Leave a workspace: `POST /v1/workspaces/:id/leave`. The last owner cannot
 * leave (they transfer ownership or delete the workspace), so the action is
 * offered only when the caller is not an owner, or another owner exists.
 * General's Danger zone and the workspace menu share it.
 */
export function useLeaveWorkspace(workspaceId: string): {
  canLeave: boolean;
  workspaceName: string;
  open: () => void;
  dialog: ReactNode;
} {
  const t = useTranslations('workspaces.settings');
  const queryClient = useQueryClient();
  const router = useUiRouter();
  const viewerId = useUiViewerId();
  const [isOpen, setOpen] = useState(false);
  const workspace = useWorkspace(workspaceId);
  const isOwner = workspace.data?.role === 'owner';
  const members = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: () => listWorkspaceMembers(workspaceId),
    enabled: isOwner,
    staleTime: 30_000,
  });
  const ownerCount = (members.data ?? []).filter((member) => memberWorkspaceRole(member) === 'owner').length;
  const canLeave = !!workspace.data && (!isOwner || ownerCount > 1);
  const workspaceName = workspace.data?.name ?? '';

  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      forgetLastProjectId(viewerId, workspaceId);
      void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
      successToast(t('leftToast', { name: workspaceName }));
      setOpen(false);
      useSettingsPanelStore.getState().close();
      router.replace(PROJECT_LANDING_PATH);
    },
    onError: (error: Error) => errorToast(error.message || t('leaveFailed')),
  });

  return {
    canLeave,
    workspaceName,
    open: () => setOpen(true),
    dialog: (
      <ConfirmDialog
        open={isOpen}
        onOpenChange={setOpen}
        title={t('leaveTitle')}
        description={t('leaveDialog', { name: workspaceName })}
        confirmLabel={t('leaveWorkspace')}
        confirmVariant="destructive"
        onConfirm={() => leave.mutate()}
        isPending={leave.isPending}
      />
    ),
  };
}
