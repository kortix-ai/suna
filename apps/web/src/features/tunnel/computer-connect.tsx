'use client';

import { listConnections, type Connection } from '@kortix/sdk';
import {
  CursorClickIcon,
  FolderIcon,
  LaptopIcon,
  MonitorIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { errorToast, successToast } from '@/components/ui/toast';
import { Download } from '@/features/icon/icons/download';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useAuth } from '@/features/providers/auth-provider';
import { tunnelKeys, useTunnelConnections, type TunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { useCopy } from '@/hooks/use-copy';
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
import { buildTunnelConnectCommand } from './tunnel-connect-command';

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
export function useOwnsPairedComputer(): {
  isSuccess: boolean;
  owns: boolean;
  /** The machines the caller paired, the live ones first. */
  owned: TunnelConnection[];
} {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const ownedBy = (machines: readonly TunnelConnection[] | undefined) =>
    user ? (machines ?? []).filter((machine) => machine.ownerUserId === user.id) : [];
  const known =
    ownedBy(queryClient.getQueryData<TunnelConnection[]>(tunnelKeys.connections())).length > 0;
  const machines = useTunnelConnections({ refetchInterval: known ? false : 60_000 });
  const owned = ownedBy(machines.data).sort((a, b) => Number(b.isLive) - Number(a.isLive));
  return { isSuccess: machines.isSuccess, owns: owned.length > 0, owned };
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

/**
 * What the workspace menu's "Your computer" row opens, and its dot:
 * - `this`: this desktop's own paired machine, with its own state.
 * - `mine`: the machines the caller paired, where this machine cannot pair in
 *   one click (a browser, or a desktop build without the agent). The dot is
 *   online when any of them is.
 * - `connect`: the connect dialog, when there is nothing to show yet.
 */
export function yourComputerMenu({
  tunnelId,
  state,
  oneClickHere,
  owned,
}: {
  tunnelId?: string;
  state?: ComputerState | null;
  oneClickHere: boolean;
  owned: readonly { isLive: boolean }[];
}): { dialog: 'this' | 'mine' | 'connect'; dot: ComputerState | null } {
  if (tunnelId) return { dialog: 'this', dot: state ?? null };
  if (!oneClickHere && owned.length > 0) {
    return { dialog: 'mine', dot: owned.some((machine) => machine.isLive) ? 'online' : 'offline' };
  }
  return { dialog: 'connect', dot: null };
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
    <ul className="divide-border divide-y">
      {CAPABILITIES.map(({ key, icon: CapabilityIcon }) => {
        const allowed = granted?.includes(key);
        return (
          <li key={key} className="flex items-center gap-3 py-3">
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-sm">
              <CapabilityIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
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
                {allowed ? <SolidCheckIcon className="text-kortix-green size-3.5" /> : null}
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
      <ModalContent
        className="space-y-0 lg:max-w-3xl"
        closeClassName="max-sm:bg-background border-0 overflow-hidden"
      >
        {/* Art beside the content from `sm`; a short banner above it on a phone.
            The art is dark in both themes, so its tokens resolve under `dark`.
            It rounds its own outer corners: the modal is a scroll container,
            and its rounded clip does not reach the shader's WebGL canvas. */}
        <div className="grid sm:grid-cols-5 lg:min-h-128">
          <div
            aria-hidden="true"
            className="dark bg-background relative isolate flex h-48 items-center justify-center overflow-hidden rounded-t-xl border-b sm:col-span-2 sm:h-auto sm:rounded-tr-none sm:border-r sm:border-b-0 lg:rounded-bl-xl"
          >
            <BeamsShader />
            <span className="bg-foreground text-background relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium">
              <LaptopIcon className="size-4 shrink-0" />
              {t('localComputerTitle')}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-5 p-5 sm:col-span-3 lg:p-8">
            <header className="space-y-1.5 pr-10">
              <ModalTitle className="text-lg font-medium text-balance">
                {t('connectTitle')}
              </ModalTitle>
              <ModalDescription className="text-pretty">{t('connectDescription')}</ModalDescription>
            </header>
            {open ? (
              <ComputerConnectOptions
                projectId={projectId}
                onConnected={(connection) => {
                  onConnected?.(connection);
                  onOpenChange(false);
                }}
              />
            ) : null}
          </div>
        </div>
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
  // The CLI fallback is one click: it copies the pairing command. The command
  // prints its own instructions when it runs.
  // The button itself confirms the copy; no toast.
  const { copied, copy } = useCopy({ toast: false });
  const copyCliCommand = () =>
    copy(
      buildTunnelConnectCommand({
        backendUrl: getEnv().BACKEND_URL || '',
        origin: window.location.origin,
        projectId,
      }),
    );

  return (
    <>
      <ComputerCapabilities />

      {/* Actions sit on the bottom edge, level with the foot of the art. */}
      <div className="mt-auto space-y-2">
        {oneClick ? (
          <Button
            size="lg"
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
          <Button size="lg" className="w-full" onClick={() => startDownload(desktopDownloadUrl())}>
            <Download className="shrink-0" />
            {t('downloadDesktop')}
          </Button>
        ) : null}
        {/* The CLI is the alternative: a quiet text action under the primary
            one. It is the only action where the desktop app cannot pair. */}
        {oneClick || inBrowser ? (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground gap-1.5"
              onClick={copyCliCommand}
            >
              {copied ? <SolidCheckIcon /> : <TerminalWindowIcon className="size-3.5 shrink-0" />}
              {copied ? t('commandCopied') : t('copyCliCommand')}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" size="lg" className="w-full" onClick={copyCliCommand}>
            {copied ? <SolidCheckIcon /> : null}
            {copied ? t('commandCopied') : t('copyCliCommand')}
          </Button>
        )}
      </div>
    </>
  );
}
