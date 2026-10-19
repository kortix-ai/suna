'use client';

import {
  CaretRightIcon,
  CursorClickIcon,
  DotsThreeIcon,
  FolderIcon,
  HandPalmIcon,
  MonitorIcon,
  PlusIcon,
  ScrollIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@kortix/ui/collapsible';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { Switch } from '@kortix/ui/switch';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { connectorHref } from '@kortix/ui/customize/connectors/connector-routes';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useDeleteTunnelConnection,
  useSetComputerAccess,
  useTunnelConnections,
  type ComputerAccess,
  type ComputerAccessChange,
  type TunnelConnection,
} from '@/hooks/tunnel/use-tunnel';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  desktopComputerDisconnect,
  desktopComputerGrants,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerRequestGrants,
  desktopComputerResume,
} from '@kortix/ui/internal/lib/desktop';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { cn } from '@kortix/ui';
import {
  ComputerCapabilities,
  computerDisplayName,
  ComputerGlyph,
  ComputerStateDot,
  DESKTOP_STATUS_KEY,
  groupOwnedComputers,
  platformName,
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useProjectComputerAccounts,
  useThisComputerState,
  type ComputerState,
} from '@kortix/ui/internal/tunnel/computer-connect';

const DESKTOP_GRANTS_KEY = ['desktop-computer-grants'] as const;

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
  const { desktop, status, tunnelId, machine, state, stale, readAt } = useThisComputerState({
    poll: true,
  });
  const { connectorAlias, connections } = useProjectComputerAccounts(projectId);
  const connect = useConnectDesktopComputer(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const access = useComputerAccess(machine, readAt);
  const grants = useComputerGrants();
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
        <ComputerSetup machine={machine} />
        {access.current?.pendingRequest && !access.current.pendingRequest.change ? (
          <AccessRequestBanner
            capability={access.current.pendingRequest.capability}
            update={access.update}
          />
        ) : null}
        {access.current ? (
          <AccessSection
            access={access.current}
            now={access.now}
            update={access.update}
            unavailable={access.unavailable}
          />
        ) : null}
        <section className="space-y-2">
          <Label>{t('capabilitiesTitle')}</Label>
          <ComputerCapabilities
            granted={machine?.capabilities ?? []}
            needsSetup={capabilitiesNeedingSetup(setupMissing(grants.data?.missing, machine))}
          />
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
                checked={access.current.keepAwake === true}
                disabled={access.update.isPending || access.unavailable !== null}
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
            <Link href={connectorHref(projectId, manageSlug)} onClick={onClose}>
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

type SetupStep = 'files' | 'accessibility' | 'screenRecording';
const SETUP_STEPS: readonly { key: SetupStep; icon: Icon }[] = [
  { key: 'files', icon: FolderIcon },
  { key: 'accessibility', icon: CursorClickIcon },
  { key: 'screenRecording', icon: MonitorIcon },
];

/**
 * What setup still needs. Files come from the desktop app (only it knows).
 * Accessibility and Screen Recording come from the agent's own report when
 * it has one: that is the process agents use, and it can lack a grant macOS
 * shows as given to the app.
 */
export function setupMissing(
  missing: readonly SetupStep[] | undefined,
  machine: Pick<TunnelConnection, 'capabilities' | 'access'> | undefined,
): SetupStep[] {
  const fromApp = [...(missing ?? [])];
  const agent = machine?.access?.desktopPermissions;
  if (!agent || !machine?.capabilities.includes('desktop')) return fromApp;
  return [
    ...fromApp.filter((step) => step === 'files'),
    ...(agent.accessibility ? [] : (['accessibility'] as const)),
    ...(agent.screenRecording ? [] : (['screenRecording'] as const)),
  ];
}

/** The capabilities whose macOS grant is still missing, for the capability list. */
export function capabilitiesNeedingSetup(missing: readonly SetupStep[] | undefined): string[] {
  const pending: string[] = [];
  if (missing?.includes('files')) pending.push('filesystem');
  if (missing?.includes('accessibility') || missing?.includes('screenRecording')) pending.push('desktop');
  return pending;
}

/**
 * The macOS grants the Kortix app holds for this computer's approved access.
 * Polls while one is missing: the person answers in macOS prompts and System
 * Settings, outside this dialog. `null` off macOS or off desktop.
 */
function useComputerGrants() {
  return useQuery({
    queryKey: DESKTOP_GRANTS_KEY,
    queryFn: async () => (await desktopComputerGrants()) ?? null,
    refetchInterval: (query) => ((query.state.data?.missing?.length ?? 0) > 0 ? 2_000 : false),
  });
}

/**
 * Setup, right after connecting: every macOS permission the approved access
 * needs, asked for on the spot with one button, so no prompt interrupts an
 * agent later. Files need Desktop, Documents, and Downloads; Screen & keyboard
 * needs Accessibility and Screen Recording. All of them go to Kortix. Each row
 * turns green as macOS answers; the desktop app restarts the agent once
 * Screen & keyboard is ready.
 */
function ComputerSetup({ machine }: { machine: TunnelConnection | undefined }) {
  const t = useTranslations('computers');
  const grants = useComputerGrants();
  const [asked, setAsked] = useState(false);
  const missing = setupMissing(grants.data?.missing, machine);
  // macOS gives the app a grant the agent process lacks: the agent predates it.
  const agentBehind = missing.some((step) => step !== 'files' && !grants.data?.missing?.includes(step));
  const request = useMutation({
    retry: false,
    mutationFn: () => desktopComputerRequestGrants({ restartAgent: agentBehind }),
    onMutate: () => setAsked(true),
    onError: (error: Error) => errorToast(error.message || t('actionFailed')),
    onSettled: () => void grants.refetch(),
  });
  // The steps shown: every one that was missing while this dialog was open, so
  // a step that turns green stays in view. Adjusted during render.
  const [steps, setSteps] = useState<readonly SetupStep[]>([]);
  const added = missing.filter((step) => !steps.includes(step));
  if (added.length > 0) setSteps([...steps, ...added]);
  if (steps.length === 0) return null;
  const done = missing.length === 0;

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{done ? t('setup.doneTitle') : t('setup.title')}</p>
        <p className="text-muted-foreground text-xs text-pretty">
          {done ? t('setup.doneHint') : t('setup.hint')}
        </p>
      </div>
      <ul className="divide-border divide-y">
        {SETUP_STEPS.filter(({ key }) => steps.includes(key)).map(({ key, icon: StepIcon }) => {
          const allowed = !missing.includes(key);
          return (
            <li key={key} className="flex items-center gap-3 py-2.5">
              <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
                <StepIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm">{t(`setup.${key}`)}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {t(`setup.${key}Description`)}
                </p>
              </div>
              <span
                className={cn(
                  'flex shrink-0 items-center gap-1 text-xs',
                  allowed ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {allowed ? <SolidCheckIcon className="text-kortix-green size-3.5" /> : null}
                {allowed ? t('capability.allowed') : asked ? t('setup.waiting') : t('setup.needed')}
              </span>
            </li>
          );
        })}
      </ul>
      {done ? null : (
        <div className="space-y-2">
          <Button className="w-full" disabled={request.isPending} onClick={() => request.mutate()}>
            {request.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('setup.allowAll')}
          </Button>
          {asked ? (
            <p className="text-muted-foreground text-xs text-pretty">{t('setup.settingsHint')}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The access the machine enforces, as its agent reports it to Kortix, and the
 * one writer: Kortix relays the change and the machine applies it. A wider
 * access waits for the owner to confirm in the prompt on the machine.
 */
function useComputerAccess(machine: TunnelConnection | undefined, readAt: number) {
  const t = useTranslations('computers');
  const setAccess = useSetComputerAccess();
  const [widening, setWidening] = useState(false);
  const tunnelId = machine?.tunnelId;
  const current = machine?.access ?? null;
  const update = {
    isPending: setAccess.isPending,
    /** A wider access waits for the owner's answer on the machine. */
    awaitingOwner: setAccess.isPending && widening,
    mutate: (change: ComputerAccessChange) => {
      if (!tunnelId) return;
      setWidening(change.mode === 'always' || change.grantMinutes !== undefined);
      setAccess.mutate(
        { tunnelId, ...change },
        { onError: (error: Error) => errorToast(error.message || t('actionFailed')) },
      );
    },
  };
  // Why the controls are read-only now, or null when they work.
  const unavailable = !current
    ? null
    : !machine?.isLive
      ? t('access.offlineHint')
      : !current.controllable
        ? t('access.updateHint')
        : null;
  // `now` is the last read (every 5 s), so render stays pure.
  return { current, now: readAt, update, unavailable };
}

type AccessUpdate = ReturnType<typeof useComputerAccess>['update'];

/**
 * A pending request (A3). Allowing it happens in the prompt on the machine,
 * where the owner sits; denying it is safe from anywhere.
 */
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
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => update.mutate({ deny: true })}
        >
          {t('access.deny')}
        </Button>
      </div>
    </InfoBanner>
  );
}

/** Ask each time · Always · Off, and one line that says what that means now. */
function AccessSection({
  access,
  now,
  update,
  unavailable,
}: {
  access: ComputerAccess;
  now: number;
  update: AccessUpdate;
  /** Why the controls are read-only, or null. */
  unavailable: string | null;
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
              <TabsTriggerCompact
                key={mode}
                value={mode}
                disabled={update.isPending || unavailable !== null}
              >
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
              disabled={update.isPending || unavailable !== null}
              onClick={() => update.mutate({ revoke: true })}
            >
              {t('access.revokeNow')}
            </Button>
          </>
        ) : denied ? (
          t('access.deniedUntil', { time: clock(denied) })
        ) : update.awaitingOwner ? (
          t('access.confirmOnComputer')
        ) : (
          t(`access.${access.mode}Status`)
        )}
      </p>
      {unavailable ? <p className="text-muted-foreground text-xs text-pretty">{unavailable}</p> : null}
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
  // In the desktop app, the machine this window runs on.
  const { tunnelId: thisTunnelId } = useThisComputerState();
  const { connectorAlias } = useProjectComputerAccounts(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<TunnelConnection | null>(null);
  const [confirmOlder, setConfirmOlder] = useState(false);
  const { computers, older } = groupOwnedComputers(owned);

  const afterRemoval = () => {
    // Its accounts leave every project's connector list too.
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
    successToast(t('disconnected'));
  };
  const removeOlder = useMutation({
    retry: false,
    // One by one: each removal revokes that registration's accounts.
    mutationFn: async (machines: readonly TunnelConnection[]) => {
      for (const machine of machines) await deleteMachine.mutateAsync(machine.tunnelId);
    },
    onSuccess: () => {
      setConfirmOlder(false);
      afterRemoval();
    },
    onError: (error: Error) => errorToast(error.message || t('disconnectFailed')),
  });

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t('yourComputersTitle')}</ModalTitle>
        {user?.email ? (
          <ModalDescription>{t('pairedWith', { email: user.email })}</ModalDescription>
        ) : null}
      </ModalHeader>
      <ModalBody className="min-h-0 space-y-4 overflow-y-auto">
        {computers.length > 0 ? (
          <ul className="divide-border divide-y">
            {computers.map((machine) => (
              <ComputerListRow
                key={machine.tunnelId}
                machine={machine}
                isThisComputer={machine.tunnelId === thisTunnelId}
                onDisconnect={() => setTarget(machine)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t('notConnected')}</p>
        )}
        {older.length > 0 ? (
          <Collapsible className="rounded-md border">
            <div className="flex items-center gap-2 px-3 py-2">
              <CollapsibleTrigger asChild>
                <Button size="sm" variant="ghost" className="group -ml-2 gap-1.5">
                  <CaretRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                  {t('older.title')}
                  <span className="text-muted-foreground tabular-nums">{older.length}</span>
                </Button>
              </CollapsibleTrigger>
              <Button
                size="sm"
                variant="ghost"
                className="text-kortix-red hover:bg-kortix-red/15 hover:text-kortix-red ml-auto"
                onClick={() => setConfirmOlder(true)}
              >
                {t('older.removeAll')}
              </Button>
            </div>
            <p className="text-muted-foreground px-3 pb-3 text-xs text-pretty">{t('older.hint')}</p>
            <CollapsibleContent>
              <ul className="divide-border divide-y border-t px-3">
                {older.map((machine) => (
                  <ComputerListRow
                    key={machine.tunnelId}
                    machine={machine}
                    isThisComputer={false}
                    onDisconnect={() => setTarget(machine)}
                  />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
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
          {computers.length > 0 ? t('connectAnother') : t('connectYourComputer')}
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
        isPending={deleteMachine.isPending && !removeOlder.isPending}
        onConfirm={() => {
          if (!target) return;
          deleteMachine.mutate(target.tunnelId, {
            onSuccess: () => {
              setTarget(null);
              afterRemoval();
            },
            onError: (error: Error) => errorToast(error.message || t('disconnectFailed')),
          });
        }}
      />
      <ConfirmDialog
        open={confirmOlder}
        onOpenChange={setConfirmOlder}
        title={t('older.confirmTitle')}
        description={t('older.confirmDescription')}
        confirmLabel={t('older.removeAll')}
        confirmVariant="destructive"
        isPending={removeOlder.isPending}
        onConfirm={() => removeOlder.mutate(older)}
      />
    </>
  );
}

/** One paired machine: name, live status, and what Kortix may use on it. */
function ComputerListRow({
  machine,
  isThisComputer,
  onDisconnect,
}: {
  machine: TunnelConnection;
  isThisComputer: boolean;
  onDisconnect: () => void;
}) {
  const t = useTranslations('computers');
  const locale = useLocale();
  const setAccess = useSetComputerAccess();
  const access = machine.access;
  const canChange = Boolean(machine.isLive && access?.controllable) && !setAccess.isPending;
  const state: ComputerState = machine.isLive ? 'online' : 'offline';
  const lastSeen =
    !machine.isLive && machine.lastHeartbeatAt ? relativeTime(machine.lastHeartbeatAt, locale) : '';
  const platform = platformName(machine.machineInfo?.platform);
  const granted = REQUEST_CAPABILITIES.filter((key) => machine.capabilities.includes(key))
    .map((key) => t(`capability.${key}`))
    .join(' · ');
  const name = computerDisplayName(machine.name, machine.machineInfo) || t('thisComputer');
  return (
    <li className="flex items-center gap-3 py-3">
      <ComputerGlyph />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {isThisComputer ? (
            <Badge variant="outline" size="xs">
              {t('thisComputerBadge')}
            </Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusText state={state} />
          {lastSeen ? <span>· {t('lastSeen', { time: lastSeen })}</span> : null}
          {platform ? <span>· {platform}</span> : null}
        </p>
        {granted ? <p className="text-muted-foreground truncate text-xs">{granted}</p> : null}
        {access ? (
          <p className="text-muted-foreground truncate text-xs">
            {t('access.title')}: {t(`access.${access.mode}`)}
          </p>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={t('actionsFor', { name })}
          >
            <DotsThreeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {access ? (
            <>
              <DropdownMenuLabel>{t('access.title')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={access.mode}
                onValueChange={(mode) =>
                  setAccess.mutate(
                    { tunnelId: machine.tunnelId, mode: mode as AccessMode },
                    { onError: (error: Error) => errorToast(error.message || t('actionFailed')) },
                  )
                }
              >
                {ACCESS_MODES.map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode} disabled={!canChange}>
                    {t(`access.${mode}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={onDisconnect}>
            {t('disconnectEllipsis')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
