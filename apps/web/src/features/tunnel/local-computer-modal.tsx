'use client';

import { HandPalmIcon, PlusIcon, ScrollIcon, WarningIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useDeleteTunnelConnection,
  useTunnelConnections,
  type TunnelConnection,
} from '@/hooks/tunnel/use-tunnel';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerAccessGet,
  desktopComputerAccessSet,
  desktopComputerDisconnect,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerResume,
} from '@/lib/desktop';
import { relativeTime } from '@/lib/relative-time';
import {
  ComputerCapabilities,
  computerDisplayName,
  ComputerGlyph,
  ComputerStateDot,
  DESKTOP_STATUS_KEY,
  platformName,
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useProjectComputerAccounts,
  useThisComputerState,
  type ComputerState,
} from './computer-connect';

const DESKTOP_ACCESS_KEY = ['desktop-computer-access'] as const;

type ComputerAccess = NonNullable<Awaited<ReturnType<typeof desktopComputerAccessGet>>>;
type AccessMode = ComputerAccess['mode'];
const ACCESS_MODES: readonly AccessMode[] = ['ask', 'always', 'off'];
const REQUEST_CAPABILITIES = ['filesystem', 'shell', 'desktop'];

/** The current approval, when it is still running. */
export function activeGrant(access: Pick<ComputerAccess, 'mode' | 'grantedUntil'>, now: number) {
  if (access.mode !== 'ask' || !access.grantedUntil) return null;
  const until = new Date(access.grantedUntil);
  return until.getTime() > now ? until : null;
}

const clock = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * "Your computer" (desktop app only): this machine's pairing, when Kortix may
 * use it (decided here, on the machine), what it may use, and its background
 * service. It follows its owner into every project; sharing it with a project
 * is the `computer` connector's Accounts tab, linked from the footer.
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
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* A column: on a short window only the body scrolls; header and footer stay. */}
      <ModalContent className="flex flex-col lg:max-w-lg">
        {open ? (
          <LocalComputerContent projectId={projectId} onClose={() => onOpenChange(false)} />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/** Glyph, name, and one status line. */
function ComputerHeader({ name, status }: { name: string; status: ReactNode }) {
  return (
    <ModalHeader className="flex-row items-center gap-3 pr-12">
      <ComputerGlyph />
      <div className="min-w-0 space-y-0.5">
        <ModalTitle className="truncate">{name}</ModalTitle>
        <ModalDescription className="flex items-center gap-1.5 text-xs">{status}</ModalDescription>
      </div>
    </ModalHeader>
  );
}

function LocalComputerContent({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('computers');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { desktop, status, tunnelId, machine, state, stale } = useThisComputerState({ poll: true });
  const { connectorAlias, connections } = useProjectComputerAccounts(projectId);
  const connect = useConnectDesktopComputer(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const access = useComputerAccess();
  const { user } = useAuth();

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
    mutationFn: async (run: boolean) => {
      const next = await (run ? desktopComputerResume() : desktopComputerPause());
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

  const name = computerDisplayName(machine?.name, machine?.machineInfo) || t('thisComputer');

  if (desktop.isPending) {
    return (
      <>
        <ComputerHeader name={t('localComputerTitle')} status={t('state.connecting')} />
        <ModalBody>
          <Loading className="size-4 shrink-0" />
        </ModalBody>
      </>
    );
  }

  if (!status?.available) {
    return (
      <>
        <ComputerHeader name={t('localComputerTitle')} status={t('notConnected')} />
        <ModalBody>
          <p className="text-muted-foreground text-sm text-pretty">
            {status?.error || t('desktopUnavailable')}
          </p>
        </ModalBody>
      </>
    );
  }

  const paired = Boolean(tunnelId && state);
  if (!paired || state === 'needsReconnect') {
    const reconnect = state === 'needsReconnect';
    return (
      <>
        <ComputerHeader
          name={reconnect ? name : t('localComputerTitle')}
          status={reconnect ? <StatusText state="needsReconnect" /> : t('notConnected')}
        />
        <ModalBody className="space-y-5">
          {reconnect ? (
            <InfoBanner tone="warning" icon={WarningIcon} title={t('needsReconnectHint')} />
          ) : null}
          <section className="space-y-2">
            <ComputerCapabilities />
            <p className="text-muted-foreground text-xs text-pretty">{t('scopeLine')}</p>
          </section>
          <Button
            className="w-full"
            disabled={connect.isPending}
            onClick={() => connect.mutate({ reauth: stale || reconnect })}
          >
            {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {connect.isPending
              ? t('connecting')
              : reconnect
                ? t('connectAgain')
                : t('connectThisComputer')}
          </Button>
        </ModalBody>
      </>
    );
  }

  const lastSeen =
    state === 'offline' && machine?.lastHeartbeatAt
      ? relativeTime(machine.lastHeartbeatAt, locale)
      : '';
  const platform = platformName(machine?.machineInfo?.platform);

  return (
    <>
      <ComputerHeader
        name={name}
        status={
          <>
            <StatusText state={state ?? 'offline'} />
            {lastSeen ? <span>· {t('lastSeen', { time: lastSeen })}</span> : null}
            {platform && state !== 'offline' ? <span>· {platform}</span> : null}
          </>
        }
      />
      <ModalBody className="min-h-0 space-y-6 overflow-y-auto">
        {access.current?.mode === 'ask' && access.current.pendingRequest ? (
          <AccessRequestBanner
            capability={access.current.pendingRequest.capability}
            update={access.update}
          />
        ) : null}
        {access.current ? (
          <AccessSection access={access.current} now={access.now} update={access.update} />
        ) : null}
        <section className="space-y-2">
          <Label>{t('capabilitiesTitle')}</Label>
          <ComputerCapabilities granted={machine?.capabilities ?? []} />
          <p className="text-muted-foreground text-xs text-pretty">{t('capabilitiesHint')}</p>
        </section>
        <SettingsRowGroup>
          <SettingsRow label={t('runInBackground')} description={t('runInBackgroundDescription')}>
            <Switch
              checked={state !== 'paused'}
              disabled={toggleService.isPending}
              onCheckedChange={(run) => toggleService.mutate(run)}
              aria-label={t('runInBackground')}
            />
          </SettingsRow>
          {access.current?.keepAwakeSupported ? (
            <SettingsRow
              label={t('access.keepAwake')}
              description={t('access.keepAwakeDescription')}
            >
              <Switch
                checked={access.current.keepAwake}
                disabled={access.update.isPending}
                onCheckedChange={(keepAwake) => access.update.mutate({ keepAwake })}
                aria-label={t('access.keepAwake')}
              />
            </SettingsRow>
          ) : null}
        </SettingsRowGroup>
        {user?.email ? (
          <p className="text-muted-foreground text-xs">{t('pairedWith', { email: user.email })}</p>
        ) : null}
      </ModalBody>
      <ModalFooter className="border-t py-3 sm:justify-between">
        <div className="flex w-full items-center gap-1 sm:w-auto">
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() =>
              void desktopComputerOpenLogs().catch((error: Error) => errorToast(error.message))
            }
          >
            <ScrollIcon className="size-3.5 shrink-0" />
            {t('showLogs')}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link
              href={`/projects/${projectId}/customize/connectors?c=${encodeURIComponent(manageSlug)}`}
              onClick={onClose}
            >
              {t('manageInProject')}
            </Link>
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-kortix-red hover:bg-kortix-red/15 hover:text-kortix-red w-full sm:w-auto"
          onClick={() => setConfirmDisconnect(true)}
        >
          {t('disconnectEllipsis')}
        </Button>
      </ModalFooter>

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

function StatusText({ state }: { state: ComputerState }) {
  const t = useTranslations('computers');
  return (
    <>
      <ComputerStateDot state={state} />
      <span>{t(`state.${state}`)}</span>
    </>
  );
}

/** The access state the agent on this machine enforces, and its one writer. */
function useComputerAccess() {
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
  // `null` on a desktop build without the access commands. `now` is the last
  // read (every 5 s), so render stays pure.
  return { current: access.data ?? null, now: access.dataUpdatedAt, update };
}

type AccessUpdate = ReturnType<typeof useComputerAccess>['update'];

/** A pending request (A3): the native prompt's choices, answerable here too. */
function AccessRequestBanner({ capability, update }: { capability: string; update: AccessUpdate }) {
  const t = useTranslations('computers');
  return (
    <InfoBanner
      tone="info"
      icon={HandPalmIcon}
      title={t(
        `access.request.${REQUEST_CAPABILITIES.includes(capability) ? capability : 'other'}`,
      )}
    >
      <div className="space-y-2.5">
        <p>{t('access.requestHint')}</p>
        {/* Below the text, not beside it: the title needs the full width. */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ grantMinutes: 60 })}
          >
            {t('access.allowHour')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ grantMinutes: 24 * 60 })}
          >
            {t('access.allowDay')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ deny: true })}
          >
            {t('access.deny')}
          </Button>
        </div>
      </div>
    </InfoBanner>
  );
}

/** Ask each time · Always · Off, and one line that says what that means now. */
function AccessSection({
  access,
  now,
  update,
}: {
  access: ComputerAccess;
  now: number;
  update: AccessUpdate;
}) {
  const t = useTranslations('computers');
  const grant = activeGrant(access, now);
  const denied =
    access.mode === 'ask' && access.deniedUntil && Date.parse(access.deniedUntil) > now
      ? new Date(access.deniedUntil)
      : null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t('access.title')}</Label>
        {/* `manual`: a click sends one change. The default also fires on the
            focus that follows the click, and "Always" asks the owner natively. */}
        <Tabs
          value={access.mode}
          activationMode="manual"
          onValueChange={(mode) => {
            if (mode !== access.mode) update.mutate({ mode: mode as AccessMode });
          }}
          className="w-fit"
        >
          <TabsListCompact aria-label={t('access.title')}>
            {ACCESS_MODES.map((mode) => (
              <TabsTriggerCompact key={mode} value={mode} disabled={update.isPending}>
                {t(`access.${mode}`)}
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
      </div>
      <p className="text-muted-foreground flex min-h-7 flex-wrap items-center gap-x-2 text-xs">
        {grant ? (
          <>
            <span className="text-foreground">
              {t('access.allowedUntil', { time: clock(grant) })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ revoke: true })}
            >
              {t('access.revokeNow')}
            </Button>
          </>
        ) : denied ? (
          t('access.deniedUntil', { time: clock(denied) })
        ) : (
          t(`access.${access.mode}Status`)
        )}
      </p>
    </section>
  );
}

/**
 * "Your computer" where this machine cannot pair in one click (a browser, or a
 * desktop build without the agent): every machine the caller paired, with its
 * live status. `onConnectAnother` opens the connect dialog.
 */
export function YourComputersModal({
  projectId,
  open,
  onOpenChange,
  onConnectAnother,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectAnother: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* No initial focus: the first control in the list is "Disconnect…". */}
      <ModalContent
        className="flex flex-col lg:max-w-lg"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {open ? (
          <YourComputersContent
            projectId={projectId}
            onClose={() => onOpenChange(false)}
            onConnectAnother={onConnectAnother}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function YourComputersContent({
  projectId,
  onClose,
  onConnectAnother,
}: {
  projectId: string;
  onClose: () => void;
  onConnectAnother: () => void;
}) {
  const t = useTranslations('computers');
  const { user } = useAuth();
  const { owned } = useOwnsPairedComputer();
  // Live status while the dialog is open: the same query, polled.
  useTunnelConnections({ refetchInterval: 10_000 });
  const { connectorAlias } = useProjectComputerAccounts(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<TunnelConnection | null>(null);

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t('yourComputersTitle')}</ModalTitle>
        {user?.email ? (
          <ModalDescription>{t('pairedWith', { email: user.email })}</ModalDescription>
        ) : null}
      </ModalHeader>
      <ModalBody className="min-h-0 overflow-y-auto">
        {owned.length > 0 ? (
          <ul className="divide-border divide-y">
            {owned.map((machine) => (
              <ComputerListRow
                key={machine.tunnelId}
                machine={machine}
                onDisconnect={() => setTarget(machine)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t('notConnected')}</p>
        )}
      </ModalBody>
      <ModalFooter className="border-t py-3 sm:justify-between">
        <Button size="sm" variant="ghost" asChild>
          <Link
            href={`/projects/${projectId}/customize/connectors?c=${encodeURIComponent(connectorAlias)}`}
            onClick={onClose}
          >
            {t('manageInProject')}
          </Link>
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={onConnectAnother}>
          <PlusIcon className="size-3.5 shrink-0" />
          {owned.length > 0 ? t('connectAnother') : t('connectYourComputer')}
        </Button>
      </ModalFooter>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) setTarget(null);
        }}
        title={t('disconnectConfirmTitle')}
        description={t('unpairDescription')}
        confirmLabel={t('disconnect')}
        confirmVariant="destructive"
        isPending={deleteMachine.isPending}
        onConfirm={() => {
          if (!target) return;
          deleteMachine.mutate(target.tunnelId, {
            onSuccess: () => {
              setTarget(null);
              successToast(t('disconnected'));
              // Its accounts leave every project's connector list too.
              void queryClient.invalidateQueries({ queryKey: ['connections'] });
            },
            onError: (error: Error) => errorToast(error.message || t('disconnectFailed')),
          });
        }}
      />
    </>
  );
}

/** One paired machine: name, live status, and what Kortix may use on it. */
function ComputerListRow({
  machine,
  onDisconnect,
}: {
  machine: TunnelConnection;
  onDisconnect: () => void;
}) {
  const t = useTranslations('computers');
  const locale = useLocale();
  const state: ComputerState = machine.isLive ? 'online' : 'offline';
  const lastSeen =
    !machine.isLive && machine.lastHeartbeatAt ? relativeTime(machine.lastHeartbeatAt, locale) : '';
  const platform = platformName(machine.machineInfo?.platform);
  const granted = REQUEST_CAPABILITIES.filter((key) => machine.capabilities.includes(key))
    .map((key) => t(`capability.${key}`))
    .join(' · ');
  return (
    <li className="flex items-center gap-3 py-3">
      <ComputerGlyph />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">
          {computerDisplayName(machine.name, machine.machineInfo) || t('thisComputer')}
        </p>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusText state={state} />
          {lastSeen ? <span>· {t('lastSeen', { time: lastSeen })}</span> : null}
          {platform ? <span>· {platform}</span> : null}
        </p>
        {granted ? <p className="text-muted-foreground truncate text-xs">{granted}</p> : null}
      </div>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onDisconnect}>
        {t('disconnectEllipsis')}
      </Button>
    </li>
  );
}
