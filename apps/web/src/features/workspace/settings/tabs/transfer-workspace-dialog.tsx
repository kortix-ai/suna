'use client';

/**
 * Transfer-workspace entry point — the settings row and its dialog.
 *
 * The API (POST /v1/projects/:id/transfer) refuses a caller who holds the
 * destructive tier on the project but no rights on the TARGET organization,
 * and answers with the target's project cap when the move would exceed its
 * plan — so this dialog only has to pick a target and say plainly what
 * moves: sessions, files, settings and member grants follow the project;
 * the usage ledger stays with the organization that consumed it.
 *
 * The project may land in an organization the mover cannot see afterwards
 * (they are not a member there) — the same outcome the Delete flow produces,
 * so success leaves the project the same way: forget the remembered landing
 * target, close the settings overlay, replace into the landing door.
 */
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsRow } from '@/components/ui/settings-row';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { forgetLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { transferProject } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from '@/i18n/use-translations';

export function TransferWorkspaceEntry({
  projectId,
  currentAccountId,
}: {
  projectId: string;
  currentAccountId?: string;
}) {
  const t = useTranslations('settings.workspace');
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsRow label={t('transferWorkspace')} description={t('transferDescription')}>
        {/* Red text like Delete: the weight belongs to the confirmation, not
            to the affordance that opens it. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setOpen(true)}
        >
          {t('transferWorkspace')}
        </Button>
      </SettingsRow>
      <TransferWorkspaceDialog
        projectId={projectId}
        currentAccountId={currentAccountId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function TransferWorkspaceDialog({
  projectId,
  currentAccountId,
  open,
  onOpenChange,
}: {
  projectId: string;
  currentAccountId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('settings.workspace');
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const [targetId, setTargetId] = useState('');

  // Same freshness contract as every other account-list reader: fetch only
  // while the dialog is open.
  const accountsQuery = useAccountsList({ enabled: open });
  // The target cannot be the account the project already lives in — the API
  // refuses that anyway — and a stale `currentAccountId` (project query still
  // in flight) is harmless: the API re-checks.
  const targetOptions = useMemo(
    () => (accountsQuery.data ?? []).filter((account) => account.account_id !== currentAccountId),
    [accountsQuery.data, currentAccountId],
  );

  const transferMutation = useMutation({
    mutationFn: () => transferProject(projectId, targetId),
    onSuccess: () => {
      successToast(t('transferSuccess'));
      // Same leave-the-project flow as Delete: the moved project must stop
      // being the remembered landing target, the global overlay must close
      // before the navigation lands, and Back must not return to a project
      // the viewer may no longer see.
      forgetLastProjectId(user?.id, projectId);
      useSettingsPanelStore.getState().close();
      // qk.projects.scope(): lists across every account plus the accountless
      // slot — the project just changed accounts, so every list form is
      // stale at once. The moved project's own caches are unreachable after
      // the replace below (the old id's entries gcTime out).
      queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      onOpenChange(false);
      router.replace(PROJECT_LANDING_PATH);
    },
    onError: (error: Error) => errorToast(error.message || t('transferFailed')),
  });

  const targetName = targetOptions.find((account) => account.account_id === targetId)?.name;

  const changeOpen = (next: boolean) => {
    if (transferMutation.isPending) return;
    if (!next) {
      setTargetId('');
      transferMutation.reset();
    }
    onOpenChange(next);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={changeOpen}
      title={t('transferTitle')}
      description={
        <div className="space-y-4">
          <p>{t('transferDialog')}</p>
          {accountsQuery.isLoading ? (
            <p>{t('transferLoadingTargets')}</p>
          ) : accountsQuery.isError ? (
            <Button variant="outline" onClick={() => accountsQuery.refetch()}>
              {t('retry')}
            </Button>
          ) : targetOptions.length === 0 ? (
            <p>{t('transferNoTargets')}</p>
          ) : (
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger className="w-full" aria-label={t('transferTargetLabel')}>
                <SelectValue placeholder={t('transferTargetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((account) => (
                  <SelectItem key={account.account_id} value={account.account_id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      }
      cancelLabel={t('keepWorkspace')}
      confirmLabel={targetName ? t('transferMoveTo', { name: targetName }) : t('transferMove')}
      confirmVariant="destructive"
      confirmDisabled={!targetName || accountsQuery.isError}
      isPending={transferMutation.isPending}
      onConfirm={() => transferMutation.mutate()}
    />
  );
}
