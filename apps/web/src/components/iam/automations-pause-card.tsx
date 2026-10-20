'use client';

// Pause all automations (KRTX-1721): one account switch that stops every
// schedule, reminder, webhook, app event and monitor in every project of the
// account. A trigger run by hand still works. Changing it takes account.write
// (owners and admins by default); everyone else sees the switch in its real
// state, disabled. Both directions confirm first, and the switch moves only
// when the query refetches after the change lands, like `SessionOversightCard`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { SettingsRow } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { getAccountAutomations, setAccountAutomationsPaused } from '@/lib/iam-client';

export const accountAutomationsQueryKey = (accountId: string) => ['account-automations', accountId] as const;

export function AutomationsPauseCard({ accountId }: { accountId: string }) {
  const t = useTranslations('automationsPause');
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: accountAutomationsQueryKey(accountId),
    queryFn: () => getAccountAutomations(accountId),
    staleTime: 30_000,
  });

  const flipMutation = useMutation({
    mutationFn: (paused: boolean) => setAccountAutomationsPaused(accountId, paused),
    onSuccess: (res) => {
      successToast(res.paused ? t('pausedToast') : t('resumedToast'));
      queryClient.invalidateQueries({ queryKey: accountAutomationsQueryKey(accountId) });
      // Every project's trigger listing (`qk.project.triggers`) carries the account switch.
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey.at(-1) === 'triggers' });
      setConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || t('failedToast')),
  });

  const paused = statusQuery.data?.paused ?? false;
  const canChange = statusQuery.data?.can_change ?? false;
  const pausedAt = statusQuery.data?.paused_at ? new Date(statusQuery.data.paused_at) : null;
  const description = [
    canChange ? t('description') : t('readOnlyDescription'),
    pausedAt ? t('pausedSince', { date: pausedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <SettingsRow label={t('label')} description={description}>
        {statusQuery.isLoading ? (
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        ) : (
          <>
            {flipMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            <Switch
              checked={paused}
              onCheckedChange={() => setConfirmOpen(true)}
              disabled={!canChange || flipMutation.isPending}
              aria-label={t('label')}
              className="shrink-0"
            />
          </>
        )}
      </SettingsRow>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!flipMutation.isPending) setConfirmOpen(v);
        }}
        title={paused ? t('resumeTitle') : t('pauseTitle')}
        description={paused ? t('resumeDescription') : t('pauseDescription')}
        confirmLabel={paused ? t('resumeConfirm') : t('pauseConfirm')}
        confirmVariant={paused ? 'default' : 'destructive'}
        isPending={flipMutation.isPending}
        onConfirm={() => flipMutation.mutate(!paused)}
      />
    </>
  );
}
