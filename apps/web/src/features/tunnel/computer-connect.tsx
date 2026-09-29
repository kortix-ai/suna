'use client';

import { listConnections, type Connection } from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { DownloadSimpleIcon, MonitorIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import {
  tunnelKeys,
  useAddComputerToProject,
  useTunnelConnections,
} from '@/hooks/tunnel/use-tunnel';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerConnect,
  desktopComputerStatus,
  desktopDownloadUrl,
  isDesktop,
  startDownload,
  type DesktopComputerStatus,
} from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';
import { cn } from '@/lib/utils';
import { absoluteBackendUrl } from './tunnel-connect-command';
import { ConnectCommandPanel } from './tunnel-connect-panel';

/**
 * A computer is an ACCOUNT of the project's `computer` connector: one
 * `connector_connections` row that points at a paired machine (`tunnel_id`).
 * Everything here reads the generic connection list; nothing keeps a second
 * list of machines per project.
 */

export const DESKTOP_STATUS_KEY = ['desktop-computer-status'] as const;

/** Same key and fetcher as `ConnectionsList`, so both share one cache entry. */
function connectionsQueryOptions(projectId: string) {
  return {
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  };
}

/** A connection that fronts a paired machine. */
export function isComputerConnection(connection: Connection): boolean {
  return Boolean(connection.tunnel_id);
}

/** The caller's own active computer accounts in this project. */
export function myComputerAccounts(
  connections: readonly Connection[] | undefined,
  userId: string | null | undefined,
): Connection[] {
  if (!userId) return [];
  return (connections ?? []).filter(
    (connection) =>
      isComputerConnection(connection) &&
      connection.owner_type === 'member' &&
      connection.owner_id === userId &&
      connection.status === 'active',
  );
}

export function useMyComputerAccounts(projectId: string, options?: { refetchInterval?: number }) {
  const { user } = useAuth();
  const query = useQuery({
    ...connectionsQueryOptions(projectId),
    refetchInterval: options?.refetchInterval,
  });
  return {
    query,
    accounts: myComputerAccounts(query.data?.connections, user?.id),
  };
}

/** True once the caller owns a paired machine, in any project. Polls once a
 *  minute: the sidebar promo mounts it for every signed-in user, and the
 *  connect dialog's own 5 s observer takes over while it is open. */
export function useOwnsPairedComputer(): { isSuccess: boolean; owns: boolean } {
  const { user } = useAuth();
  const machines = useTunnelConnections({ refetchInterval: 60_000 });
  return {
    isSuccess: machines.isSuccess,
    owns: Boolean(user && machines.data?.some((machine) => machine.ownerUserId === user.id)),
  };
}

/**
 * The desktop app's local tunnel agent. `null` in a browser, and on a desktop
 * build that predates the computer commands. Resolved client-side only, so the
 * server render and the first client render agree.
 */
export function useDesktopComputer() {
  return useQuery({
    queryKey: DESKTOP_STATUS_KEY,
    queryFn: async () => (isDesktop() ? ((await desktopComputerStatus()) ?? null) : null),
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data ? 10_000 : false),
  });
}

/** One-click pairing through the desktop app. Resolves once the service runs. */
export function useConnectDesktopComputer(projectId: string) {
  const t = useTranslations('computers');
  const queryClient = useQueryClient();
  return useMutation({
    // Never retried: a failure is usually the person closing the approval
    // window, and a retry would open it again.
    retry: false,
    mutationFn: async () => {
      const result = await desktopComputerConnect({
        apiUrl: absoluteBackendUrl({
          backendUrl: getEnv().BACKEND_URL || '',
          origin: window.location.origin,
        }),
        projectId,
      });
      if (!result) throw new Error(t('desktopUnavailable'));
      if (!result.ok) throw new Error(result.error || t('connectFailed'));
      return result;
    },
    onSuccess: () => {
      successToast(t('connected'));
    },
    onError: (error: Error) => errorToast(error.message || t('connectFailed')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections', projectId] });
      void queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      void queryClient.invalidateQueries({ queryKey: DESKTOP_STATUS_KEY });
    },
  });
}

export type ComputerState = 'online' | 'connecting' | 'offline' | 'stopped';

/**
 * One status for this machine, from both sides: the desktop service (local)
 * and the relay heartbeat (server). The server wins when it has an answer,
 * because it is what a cloud session sees.
 */
export function computerState(
  local: DesktopComputerStatus | null | undefined,
  serverLive: boolean | undefined,
): ComputerState {
  if (!local?.serviceActive) return 'stopped';
  if (serverLive) return 'online';
  if (local.status === 'connecting' || local.status === 'online') return 'connecting';
  return 'offline';
}

/** This desktop's paired machine and its combined state. `null` outside the desktop app. */
export function useThisComputerState() {
  const desktop = useDesktopComputer();
  const status = desktop.data;
  const tunnelId = status?.paired ? status.tunnelId : undefined;
  const machines = useTunnelConnections({ refetchInterval: tunnelId ? 10_000 : false });
  const machine = machines.data?.find((candidate) => candidate.tunnelId === tunnelId);
  return {
    desktop,
    status,
    tunnelId,
    machine,
    state: tunnelId ? computerState(status, machine?.isLive) : null,
  };
}

/** Status dot + label, e.g. in the workspace menu and the "Your computer" dialog. */
export function ComputerStateDot({ state, className }: { state: ComputerState; className?: string }) {
  const t = useTranslations('computers');
  return (
    <span
      role="img"
      aria-label={t(`state.${state}`)}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'online' ? 'bg-kortix-green' : 'bg-muted-foreground',
        state === 'stopped' && 'bg-transparent ring-1 ring-muted-foreground',
        className,
      )}
    />
  );
}

/** Online/offline dot for a machine. `null` = status unknown. */
export function MachineDot({
  online,
  className,
}: {
  online: boolean | null | undefined;
  className?: string;
}) {
  const t = useTranslations('computers');
  return (
    <span
      role="img"
      aria-label={online ? t('online') : t('offline')}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online ? 'bg-kortix-green' : 'bg-muted-foreground',
        className,
      )}
    />
  );
}

/**
 * "Connect your computer": every way to add a computer account to this project.
 *
 * 1. A machine the caller already paired, not yet in this project → Use here.
 * 2. The desktop app, this machine unpaired → one click.
 * 3. A browser → download the desktop app; the npx command is one click away.
 *
 * Closes itself when a new computer account of the caller's appears.
 */
export function ComputerConnectModal({
  projectId,
  open,
  onOpenChange,
  onConnected,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: (connection: Connection) => void;
}) {
  const t = useTranslations('computers');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('connectTitle')}</ModalTitle>
          <ModalDescription>{t('connectDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-6 overflow-y-auto">
          {open ? (
            <ComputerConnectOptions
              projectId={projectId}
              onConnected={(connection) => {
                onConnected?.(connection);
                onOpenChange(false);
              }}
            />
          ) : null}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function ComputerConnectOptions({
  projectId,
  onConnected,
}: {
  projectId: string;
  onConnected: (connection: Connection) => void;
}) {
  const t = useTranslations('computers');
  const { user } = useAuth();
  const accountId = useProjectAccountId(projectId);
  // Polls while open: pairing finishes on another page (the approval page) or
  // in the desktop app, and this dialog closes itself when the account lands.
  const { query, accounts } = useMyComputerAccounts(projectId, { refetchInterval: 5_000 });
  const machines = useTunnelConnections();
  const desktop = useDesktopComputer();
  const connectDesktop = useConnectDesktopComputer(projectId);
  const addComputer = useAddComputerToProject();

  // The accounts that existed when the dialog opened. Adjusted during render:
  // the first loaded list is the baseline, and a later new one is the result.
  const [baseline, setBaseline] = useState<Set<string> | null>(null);
  if (baseline === null && query.isSuccess) {
    setBaseline(new Set(accounts.map((account) => account.connection_id)));
  }
  const added = baseline
    ? accounts.find((account) => !baseline.has(account.connection_id))
    : undefined;
  const addedId = added?.connection_id;
  useEffect(() => {
    if (added) onConnected(added);
    // Once per new account; `added` is a fresh object on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedId]);

  const linked = new Set(accounts.map((account) => account.tunnel_id));
  const candidates = (machines.data ?? []).filter(
    (machine) =>
      machine.accountId === accountId &&
      !linked.has(machine.tunnelId) &&
      (machine.ownerUserId == null || machine.ownerUserId === user?.id),
  );
  const desktopStatus = desktop.data;
  const desktopUnpaired = Boolean(desktopStatus?.available && !desktopStatus.paired);
  const inBrowser = desktop.isSuccess && !desktopStatus && !isDesktop();
  // The CLI is the fallback: shown on request, or when nothing else applies
  // (a desktop build without the bundled agent).
  const [cliOpen, setCliOpen] = useState(false);
  const showCli =
    cliOpen || (desktop.isSuccess && !inBrowser && !desktopUnpaired && candidates.length === 0);

  return (
    <>
      {candidates.length > 0 ? (
        <section className="space-y-2">
          <Label>{t('yourComputers')}</Label>
          <ul className="space-y-2">
            {candidates.map((machine) => {
              const pending =
                addComputer.isPending && addComputer.variables?.tunnelId === machine.tunnelId;
              return (
                <li
                  key={machine.tunnelId}
                  className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2"
                >
                  <MonitorIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {machine.name}
                  </span>
                  <MachineDot online={machine.isLive} />
                  <Button
                    size="sm"
                    disabled={addComputer.isPending}
                    onClick={() =>
                      addComputer.mutate(
                        { projectId, tunnelId: machine.tunnelId, share: 'me' },
                        {
                          onSuccess: () => successToast(t('connected')),
                          onError: (error: Error) =>
                            errorToast(error.message || t('connectFailed')),
                        },
                      )
                    }
                  >
                    {pending ? <Loading className="size-4 shrink-0" /> : null}
                    {t('useHere')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {desktopUnpaired ? (
        <Button
          className="w-full"
          disabled={connectDesktop.isPending}
          onClick={() => connectDesktop.mutate()}
        >
          {connectDesktop.isPending ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <MonitorIcon className="size-4 shrink-0" />
          )}
          {connectDesktop.isPending ? t('connecting') : t('connectThisComputer')}
        </Button>
      ) : null}

      {inBrowser ? (
        <section className="space-y-2">
          <Button className="w-full" onClick={() => startDownload(desktopDownloadUrl())}>
            <DownloadSimpleIcon className="size-4 shrink-0" />
            {t('downloadDesktop')}
          </Button>
          <p className="text-muted-foreground text-xs text-pretty">{t('downloadHint')}</p>
        </section>
      ) : null}

      {showCli ? (
        <section className="space-y-2">
          <Label>{t('runCommand')}</Label>
          <p className="text-muted-foreground text-xs text-pretty">{t('cliHint')}</p>
          <ConnectCommandPanel projectId={projectId} />
        </section>
      ) : (
        <Button variant="ghost" size="sm" className="w-full" onClick={() => setCliOpen(true)}>
          <TerminalWindowIcon className="size-4 shrink-0" />
          {t('useCliInstead')}
        </Button>
      )}
    </>
  );
}
