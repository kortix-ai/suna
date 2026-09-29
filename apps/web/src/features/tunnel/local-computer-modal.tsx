'use client';

import { MonitorIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAddComputerToProject, useDeleteTunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerDisconnect,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerResume,
  type DesktopComputerStatus,
} from '@/lib/desktop';
import {
  ComputerStateDot,
  DESKTOP_STATUS_KEY,
  useConnectDesktopComputer,
  useMyComputerAccounts,
  useThisComputerState,
} from './computer-connect';

/**
 * "Your computer" (desktop app only): this machine's pairing and background
 * service. Who may use the machine in a project is the `computer` connector's
 * Accounts tab, linked from here.
 */
export function LocalComputerModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('computers');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('localComputerTitle')}</ModalTitle>
          <ModalDescription>{t('localComputerDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          {open ? (
            <LocalComputerBody projectId={projectId} onClose={() => onOpenChange(false)} />
          ) : null}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function LocalComputerBody({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('computers');
  const queryClient = useQueryClient();
  const { desktop, status, tunnelId, machine, state } = useThisComputerState();
  const { accounts } = useMyComputerAccounts(projectId);
  const connect = useConnectDesktopComputer(projectId);
  const addComputer = useAddComputerToProject();
  const deleteMachine = useDeleteTunnelConnection();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const account = accounts.find((candidate) => candidate.tunnel_id === tunnelId);

  const setStatus = (next: DesktopComputerStatus | null) => {
    if (next) queryClient.setQueryData(DESKTOP_STATUS_KEY, next);
    void queryClient.invalidateQueries({ queryKey: DESKTOP_STATUS_KEY });
  };
  // Local IPC calls: a failure is final, never retried.
  const toggleService = useMutation({
    retry: false,
    mutationFn: () => (status?.serviceActive ? desktopComputerPause() : desktopComputerResume()),
    onSuccess: setStatus,
    onError: (error: Error) => errorToast(error.message),
  });
  const disconnect = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await desktopComputerDisconnect();
      if (!result?.ok) throw new Error(t('disconnectFailed'));
      // The local credential is gone; remove the machine and its accounts too.
      if (tunnelId) await deleteMachine.mutateAsync(tunnelId);
      return result.status;
    },
    onSuccess: (next) => {
      setConfirmDisconnect(false);
      setStatus(next);
      successToast(t('disconnected'));
    },
    onError: (error: Error) => errorToast(error.message || t('disconnectFailed')),
  });

  if (desktop.isPending) return <Loading className="size-4 shrink-0" />;

  if (!status?.available) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        {status?.error || t('desktopUnavailable')}
      </p>
    );
  }

  if (!tunnelId || !state) {
    return (
      <Button className="w-full" disabled={connect.isPending} onClick={() => connect.mutate()}>
        {connect.isPending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <MonitorIcon className="size-4 shrink-0" />
        )}
        {connect.isPending ? t('connecting') : t('connectThisComputer')}
      </Button>
    );
  }

  return (
    <>
      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <MonitorIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {machine?.name ?? t('thisComputer')}
        </span>
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <ComputerStateDot state={state} />
          {t(`state.${state}`)}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {account ? null : (
          <Button
            size="sm"
            disabled={addComputer.isPending}
            onClick={() =>
              addComputer.mutate(
                { projectId, tunnelId, share: 'me' },
                {
                  onSuccess: () => successToast(t('connected')),
                  onError: (error: Error) => errorToast(error.message || t('connectFailed')),
                },
              )
            }
          >
            {addComputer.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('useInThisProject')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={toggleService.isPending}
          onClick={() => toggleService.mutate()}
        >
          {toggleService.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {status?.serviceActive ? t('pauseAccess') : t('startAccess')}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link
            href={`/projects/${projectId}/customize/connectors?c=${encodeURIComponent(account?.connector_alias ?? 'computer')}`}
            onClick={onClose}
          >
            {t('manageAccess')}
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={() => void desktopComputerOpenLogs()}>
          {t('showLogs')}
        </Button>
      </div>

      <div className="bg-popover rounded-md border px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{t('disconnectTitle')}</p>
            <p className="text-muted-foreground text-xs text-pretty">
              {t('disconnectDescription')}
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setConfirmDisconnect(true)}>
            {t('disconnect')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t('disconnectConfirmTitle')}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        confirmVariant="destructive"
        isPending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </>
  );
}
