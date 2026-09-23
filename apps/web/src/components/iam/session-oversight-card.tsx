'use client';

// Account session oversight toggle on the Settings tab. Off by default.
// When ON, account owners and admins can open EVERY session in the account,
// members' private ones included; they find them on the project's Sessions
// page. Every flip and every session opened this way is in the audit log.
//
// Only an account OWNER may change it (`can_change`): an admin must not be
// able to grant themselves read access to everyone's work. Everyone else sees
// the switch in its real state, disabled, with the reason.
//
// A bare `SettingsRow` — mount it inside a `SettingsRowGroup`, like
// `MfaRequiredCard`. Both directions confirm first: turning it on exposes
// private work, turning it off takes access away from admins. The switch never
// moves optimistically; the query invalidation after the mutation lands is
// what moves it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { SettingsRow } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { getSessionOversight, setSessionOversight } from '@/lib/iam-client';

export const sessionOversightQueryKey = (accountId: string) =>
  ['iam-session-oversight', accountId] as const;

export function SessionOversightCard({ accountId }: { accountId: string }) {
  const t = useTranslations('sessionOversight');
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: sessionOversightQueryKey(accountId),
    queryFn: () => getSessionOversight(accountId),
    staleTime: 30_000,
  });

  const flipMutation = useMutation({
    mutationFn: (enabled: boolean) => setSessionOversight(accountId, enabled),
    onSuccess: (res) => {
      successToast(res.enabled ? t.raw('enabledToast') : t.raw('disabledToast'));
      queryClient.invalidateQueries({ queryKey: sessionOversightQueryKey(accountId) });
      setConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || t.raw('failedToast')),
  });

  const enabled = statusQuery.data?.enabled ?? false;
  const canChange = statusQuery.data?.can_change ?? false;

  return (
    <>
      <SettingsRow
        label={t.raw('label')}
        description={canChange ? t.raw('description') : t.raw('ownerOnlyDescription')}
      >
        {statusQuery.isLoading ? (
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        ) : (
          <>
            {flipMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            <Switch
              checked={enabled}
              onCheckedChange={() => setConfirmOpen(true)}
              disabled={!canChange || flipMutation.isPending}
              aria-label={t.raw('label')}
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
        title={enabled ? t.raw('disableTitle') : t.raw('enableTitle')}
        description={enabled ? t.raw('disableDescription') : t.raw('enableDescription')}
        confirmLabel={enabled ? t.raw('disableConfirm') : t.raw('enableConfirm')}
        confirmVariant={enabled ? 'default' : 'destructive'}
        isPending={flipMutation.isPending}
        onConfirm={() => flipMutation.mutate(!enabled)}
      />
    </>
  );
}
