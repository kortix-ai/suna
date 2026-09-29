'use client';

import { MonitorIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useDeleteTunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerAccessGet,
  desktopComputerAccessSet,
  desktopComputerDisconnect,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerResume,
} from '@/lib/desktop';
import {
  ComputerStateDot,
  DESKTOP_STATUS_KEY,
  useConnectDesktopComputer,
  useProjectComputerAccounts,
  useThisComputerState,
} from './computer-connect';

const DESKTOP_ACCESS_KEY = ['desktop-computer-access'] as const;

type ComputerAccess = NonNullable<Awaited<ReturnType<typeof desktopComputerAccessGet>>>;
type AccessMode = ComputerAccess['mode'];
const ACCESS_MODES: readonly AccessMode[] = ['ask', 'always', 'off'];

/** The current approval, when it is still running. */
export function activeGrant(access: Pick<ComputerAccess, 'mode' | 'grantedUntil'>, now: number) {
  if (access.mode !== 'ask' || !access.grantedUntil) return null;
  const until = new Date(access.grantedUntil);
  return until.getTime() > now ? until : null;
}

/**
 * "Your computer" (desktop app only): this machine's pairing, who may use it
 * (decided here, on the machine), and its background service. It follows its
 * owner into every project; sharing it with a project is the `computer`
 * connector's Accounts tab, linked from here.
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
        <ModalBody className="max-h-[70vh] space-y-6 overflow-y-auto">
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
  const { desktop, status, tunnelId, machine, state, stale } = useThisComputerState({ poll: true });
  const { connectorAlias, connections } = useProjectComputerAccounts(projectId);
  const connect = useConnectDesktopComputer(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Any account of this machine in the project, shared or private, names the
  // connector; an older project may use another slug than `computer`.
  const manageSlug =
    connections?.find((connection) => connection.tunnel_id === tunnelId)?.connector_alias ??
    connectorAlias;

  const refreshStatus = () => void queryClient.invalidateQueries({ queryKey: DESKTOP_STATUS_KEY });
  // Local IPC calls: a failure is final, never retried.
  const toggleService = useMutation({
    retry: false,
    // Rejects with the desktop app's reason when it could not change the service.
    mutationFn: async () => {
      const next = await (state === 'paused' ? desktopComputerResume() : desktopComputerPause());
      if (!next) throw new Error(t('desktopUnavailable'));
      return next;
    },
    onSuccess: (next) => queryClient.setQueryData(DESKTOP_STATUS_KEY, next),
    onError: (error: Error) => errorToast(error.message || t('actionFailed')),
    onSettled: refreshStatus,
  });
  // Server first, while the local credential can still be used again if the
  // delete fails; then the local logout. A machine this backend no longer
  // lists (`stale`) only needs the local half.
  const disconnect = useMutation({
    retry: false,
    mutationFn: async () => {
      if (tunnelId) await deleteMachine.mutateAsync(tunnelId);
      const result = await desktopComputerDisconnect();
      if (!result?.ok) throw new Error(result?.error || t('disconnectFailed'));
      return result.status;
    },
    onSuccess: (next) => {
      setConfirmDisconnect(false);
      queryClient.setQueryData(DESKTOP_STATUS_KEY, next);
      successToast(t('disconnected'));
    },
    onError: (error: Error) => errorToast(error.message || t('disconnectFailed')),
    onSettled: refreshStatus,
  });

  if (desktop.isPending) return <Loading className="size-4 shrink-0" />;

  if (!status?.available) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        {status?.error || t('desktopUnavailable')}
      </p>
    );
  }

  const paired = Boolean(tunnelId && state);
  if (!paired || state === 'needsReconnect') {
    return (
      <>
        {state === 'needsReconnect' ? (
          <p className="text-muted-foreground text-sm text-pretty">{t('needsReconnectHint')}</p>
        ) : null}
        <Button
          className="w-full"
          disabled={connect.isPending}
          onClick={() => connect.mutate({ reauth: stale || state === 'needsReconnect' })}
        >
          {connect.isPending ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <MonitorIcon className="size-4 shrink-0" />
          )}
          {connect.isPending ? t('connecting') : t('connectThisComputer')}
        </Button>
      </>
    );
  }

  return (
    <>
      <section className="space-y-2">
        <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
          <MonitorIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {machine?.name ?? t('thisComputer')}
          </span>
          {state ? (
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              <ComputerStateDot state={state} />
              {t(`state.${state}`)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={toggleService.isPending}
            onClick={() => toggleService.mutate()}
          >
            {toggleService.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {state === 'paused' ? t('resumeAccess') : t('pauseAccess')}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link
              href={`/projects/${projectId}/customize/connectors?c=${encodeURIComponent(manageSlug)}`}
              onClick={onClose}
            >
              {t('manageAccess')}
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void desktopComputerOpenLogs().catch((error: Error) => errorToast(error.message))
            }
          >
            {t('showLogs')}
          </Button>
        </div>
      </section>

      <AccessControls />

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

/**
 * Who may use this computer, enforced by the agent on this machine: ask each
 * time, always, or off. Hidden on a desktop build without the access commands.
 */
function AccessControls() {
  const t = useTranslations('computers');
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: DESKTOP_ACCESS_KEY,
    queryFn: async () => (await desktopComputerAccessGet()) ?? null,
    // The approval prompt is answered outside this dialog.
    refetchInterval: 5_000,
  });
  const update = useMutation({
    retry: false,
    mutationFn: async (input: Parameters<typeof desktopComputerAccessSet>[0]) => {
      const next = await desktopComputerAccessSet(input);
      if (!next) throw new Error(t('desktopUnavailable'));
      return next;
    },
    onSuccess: (next) => queryClient.setQueryData(DESKTOP_ACCESS_KEY, next),
    onError: (error: Error) => errorToast(error.message || t('actionFailed')),
  });

  const current = access.data;
  if (!current) return null;
  // Measured at the last read (every 5 s), so render stays pure.
  const grant = activeGrant(current, access.dataUpdatedAt);

  return (
    <section className="space-y-3">
      <Label>{t('access.title')}</Label>
      <RadioGroup
        value={current.mode}
        onValueChange={(mode) => update.mutate({ mode: mode as AccessMode })}
        disabled={update.isPending}
      >
        {ACCESS_MODES.map((mode) => (
          <RadioGroupItem
            key={mode}
            value={mode}
            variant="outline"
            label={t(`access.${mode}`)}
            description={t(`access.${mode}Description`)}
          />
        ))}
      </RadioGroup>
      {grant ? (
        <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-2">
          <span className="text-sm">
            {t('access.allowedUntil', {
              time: grant.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ revoke: true })}
          >
            {t('access.revokeNow')}
          </Button>
        </div>
      ) : null}
      {/* R6: shown on every platform; Windows says it is not available yet. */}
      <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{t('access.keepAwake')}</p>
          <p className="text-muted-foreground text-xs text-pretty">
            {current.keepAwakeSupported
              ? t('access.keepAwakeDescription')
              : t('access.keepAwakeUnsupported')}
          </p>
        </div>
        <Switch
          checked={current.keepAwakeSupported && current.keepAwake}
          disabled={update.isPending || !current.keepAwakeSupported}
          onCheckedChange={(keepAwake) => update.mutate({ keepAwake })}
          aria-label={t('access.keepAwake')}
        />
      </div>
    </section>
  );
}
