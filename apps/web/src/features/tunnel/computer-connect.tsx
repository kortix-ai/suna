'use client';

import { listConnections, type Connection } from '@kortix/sdk';
import {
  CheckIcon,
  CursorClickIcon,
  DownloadSimpleIcon,
  FolderIcon,
  LaptopIcon,
  MonitorIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';
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
import { tunnelKeys, useTunnelConnections } from '@/hooks/tunnel/use-tunnel';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerConnect,
  desktopComputerStatus,
  desktopDownloadUrl,
  isDesktop,
  startDownload,
  type DesktopComputerStatus,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';
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

/**
 * A machine's name for people: its own friendly name (`machineInfo.displayName`,
 * e.g. "Ada's MacBook Pro") until the owner picks another, and never the
 * `.local` suffix of a raw hostname. Empty when nothing names it.
 */
export function computerDisplayName(
  name: string | null | undefined,
  machineInfo?: Record<string, unknown> | null,
): string {
  const own = name?.trim() ?? '';
  const host = typeof machineInfo?.hostname === 'string' ? machineInfo.hostname : '';
  const friendly =
    typeof machineInfo?.displayName === 'string' ? machineInfo.displayName.trim() : '';
  const chosen = friendly && (!own || own === host) ? friendly : own;
  return chosen.replace(/\.local$/i, '');
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/** `darwin` → macOS. `null` for anything the agent did not report. */
export function platformName(platform: unknown): string | null {
  return typeof platform === 'string' ? (PLATFORM_NAMES[platform] ?? null) : null;
}

/**
 * The active computer accounts in this project the caller can use: their own
 * (which follow them into every project) and the project-shared ones.
 */
export function projectComputerAccounts(
  connections: readonly Connection[] | undefined,
  userId: string | null | undefined,
): Connection[] {
  if (!userId) return [];
  return (connections ?? []).filter(
    (connection) =>
      isComputerConnection(connection) &&
      connection.status === 'active' &&
      (connection.owner_type === 'project' ||
        (connection.owner_type === 'member' && connection.owner_id === userId)),
  );
}

export function useProjectComputerAccounts(
  projectId: string,
  options?: { refetchInterval?: number },
) {
  const { user } = useAuth();
  const query = useQuery({
    ...connectionsQueryOptions(projectId),
    refetchInterval: options?.refetchInterval,
  });
  const connections = query.data?.connections;
  return {
    query,
    accounts: projectComputerAccounts(connections, user?.id),
    /** The project's computer connector slug, whatever an older project named it. */
    connectorAlias: connections?.find(isComputerConnection)?.connector_alias ?? 'computer',
    connections,
  };
}

/** True once the caller owns a paired machine, in any project. Polls once a
 *  minute until they do: the sidebar promo mounts it for every signed-in user
 *  and hides for good once they own one, so polling then would be waste. The
 *  connect dialog's own 5 s observer takes over while it is open. */
export function useOwnsPairedComputer(): { isSuccess: boolean; owns: boolean } {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const ownsAny = (machines: readonly { ownerUserId?: string | null }[] | undefined) =>
    Boolean(user && machines?.some((machine) => machine.ownerUserId === user.id));
  const known = ownsAny(queryClient.getQueryData(tunnelKeys.connections()));
  const machines = useTunnelConnections({ refetchInterval: known ? false : 60_000 });
  return { isSuccess: machines.isSuccess, owns: ownsAny(machines.data) };
}

/**
 * The desktop app's local tunnel agent. `null` in a browser, and on a desktop
 * build that predates the computer commands. Resolved client-side only, so the
 * server render and the first client render agree.
 *
 * Read once per mount; `poll` refreshes it every 5 s, only while the "Your
 * computer" dialog is open. Every read asks the desktop app for its status.
 */
export function useDesktopComputer({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: DESKTOP_STATUS_KEY,
    queryFn: async () => (isDesktop() ? ((await desktopComputerStatus()) ?? null) : null),
    staleTime: 10_000,
    refetchInterval: (query) => (poll && query.state.data ? 5_000 : false),
  });
}

/**
 * One-click pairing through the desktop app. Resolves once the service runs.
 * `reauth` drops a stale local pairing first (see `useThisComputerState`).
 */
export function useConnectDesktopComputer(projectId: string) {
  const t = useTranslations('computers');
  const queryClient = useQueryClient();
  return useMutation({
    // Never retried: a failure is usually the person closing the approval
    // window, and a retry would open it again.
    retry: false,
    mutationFn: async (options?: { reauth?: boolean }) => {
      // The desktop app derives the backend from its own instance (X6).
      const result = await desktopComputerConnect({
        projectId,
        reauth: options?.reauth === true,
      });
      if (!result) throw new Error(t('desktopUnavailable'));
      // Closing the approval window is the person's choice, not an error.
      if (!result.ok && result.error === 'cancelled') return result;
      if (!result.ok) throw new Error(result.error || t('connectFailed'));
      return result;
    },
    onSuccess: (result) => {
      if (result.ok) successToast(t('connected'));
    },
    onError: (error: Error) => errorToast(error.message || t('connectFailed')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections', projectId] });
      void queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      void queryClient.invalidateQueries({ queryKey: DESKTOP_STATUS_KEY });
    },
  });
}

export type ComputerState = 'online' | 'connecting' | 'offline' | 'paused' | 'needsReconnect';

/**
 * One status for this machine, from both sides: the desktop service (local)
 * and the relay heartbeat (server). The server wins when it has an answer,
 * because it is what a cloud session sees.
 *
 * - `paused`: the owner paused computer access (it stays paused across a
 *   restart). A stopped service that is not paused reads offline: the desktop
 *   app repairs it.
 * - `needsReconnect`: the API refused the machine's credential (`rejected`):
 *   it was disconnected elsewhere. Connecting again pairs it afresh.
 */
export function computerState(
  local: DesktopComputerStatus | null | undefined,
  serverLive: boolean | undefined,
): ComputerState {
  if (local?.paused) return 'paused';
  if (local?.state === 'rejected') return 'needsReconnect';
  if (serverLive) return 'online';
  const live = local?.state;
  if (live === 'connecting' || live === 'online' || live === 'standby') return 'connecting';
  return 'offline';
}

/**
 * This desktop's paired machine and its combined state. `null` outside the
 * desktop app.
 *
 * `stale`: the desktop holds a pairing this backend does not list for the
 * signed-in user (unpaired elsewhere, another person's, another backend's).
 * It is treated as unpaired, and connecting again re-pairs (`reauth`).
 */
export function useThisComputerState({ poll = false }: { poll?: boolean } = {}) {
  const desktop = useDesktopComputer({ poll });
  const status = desktop.data;
  const localTunnelId = status?.paired ? status.tunnelId : undefined;
  const machines = useTunnelConnections({
    refetchInterval: poll && localTunnelId ? 10_000 : false,
  });
  const machine = machines.data?.find((candidate) => candidate.tunnelId === localTunnelId);
  const stale = Boolean(localTunnelId && machines.isSuccess && !machine);
  const tunnelId = stale ? undefined : localTunnelId;
  return {
    desktop,
    status,
    tunnelId,
    machine,
    /** False where the deployment has computers disabled (`/tunnel/connections` answers 503). */
    computersEnabled: machines.isSuccess,
    stale,
    /** The desktop app can pair this machine in one click. */
    oneClick: Boolean(status?.available && !tunnelId),
    state: tunnelId ? computerState(status, machine?.isLive) : null,
  };
}

/** Status dot, e.g. in the workspace menu, the "Your computer" dialog, account rows. */
export function ComputerStateDot({
  state,
  className,
}: {
  state: ComputerState;
  className?: string;
}) {
  const t = useTranslations('computers');
  return (
    <span
      role="img"
      aria-label={t(`state.${state}`)}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'online'
          ? 'bg-kortix-green'
          : state === 'needsReconnect'
            ? 'bg-kortix-orange'
            : 'bg-muted-foreground',
        state === 'paused' && 'ring-muted-foreground bg-transparent ring-1',
        className,
      )}
    />
  );
}

/** The device glyph in a muted tile: the computer's avatar everywhere it appears. */
export function ComputerGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm',
        className,
      )}
    >
      <LaptopIcon className="size-5" />
    </span>
  );
}

const CAPABILITIES: readonly { key: 'filesystem' | 'shell' | 'desktop'; icon: Icon }[] = [
  { key: 'filesystem', icon: FolderIcon },
  { key: 'shell', icon: TerminalWindowIcon },
  { key: 'desktop', icon: CursorClickIcon },
];

/**
 * What Kortix can use on a computer. With `granted` (the capabilities approved
 * at pairing) each row says Allowed / Not allowed; without it, it is a preview.
 */
export function ComputerCapabilities({ granted }: { granted?: readonly string[] }) {
  const t = useTranslations('computers');
  return (
    <ul className="bg-popover divide-border divide-y rounded-md border">
      {CAPABILITIES.map(({ key, icon: CapabilityIcon }) => {
        const allowed = granted?.includes(key);
        return (
          <li key={key} className="flex items-center gap-3 px-4 py-2.5">
            <CapabilityIcon className="text-muted-foreground size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t(`capability.${key}`)}</p>
              <p className="text-muted-foreground truncate text-xs">
                {t(`capability.${key}Description`)}
              </p>
            </div>
            {granted ? (
              <span
                className={cn(
                  'flex shrink-0 items-center gap-1 text-xs',
                  allowed ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {allowed ? <CheckIcon className="text-kortix-green size-3.5 shrink-0" /> : null}
                {allowed ? t('capability.allowed') : t('capability.notAllowed')}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Connect your computer": every way to pair a machine.
 *
 * 1. The desktop app, this machine unpaired → one click.
 * 2. A browser → download the desktop app; the npx command is one click away.
 *
 * A paired machine follows its owner into every project, so there is no
 * per-project step. Closes itself when a new computer account appears here.
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
        <ModalHeader className="flex-row items-center gap-3 pr-12">
          <ComputerGlyph />
          <div className="min-w-0 space-y-0.5">
            <ModalTitle>{t('connectTitle')}</ModalTitle>
            <ModalDescription className="text-xs">{t('connectDescription')}</ModalDescription>
          </div>
        </ModalHeader>
        <ModalBody className="space-y-5">
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
  // Polls while open: pairing finishes on another page (the approval page) or
  // in the desktop app, and this dialog closes itself when the account lands.
  const { query, accounts } = useProjectComputerAccounts(projectId, { refetchInterval: 5_000 });
  const { desktop, oneClick, stale } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);

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

  const inBrowser = desktop.isSuccess && !desktop.data && !isDesktop();
  // The CLI is the fallback: shown on request, or when nothing else applies
  // (this desktop is already paired, or its build lacks the bundled agent).
  const [cliOpen, setCliOpen] = useState(false);
  const showCli = cliOpen || (desktop.isSuccess && !inBrowser && !oneClick);

  return (
    <>
      <section className="space-y-2">
        <ComputerCapabilities />
        <p className="text-muted-foreground text-xs text-pretty">{t('scopeLine')}</p>
      </section>

      {oneClick ? (
        <Button
          className="w-full"
          disabled={connectDesktop.isPending}
          onClick={() => connectDesktop.mutate({ reauth: stale })}
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
        <section className="space-y-2 border-t pt-5">
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
