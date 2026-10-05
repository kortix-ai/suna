'use client';

import {
  BatteryChargingIcon,
  CaretRightIcon,
  CursorClickIcon,
  DotsThreeIcon,
  FolderIcon,
  HandPalmIcon,
  MonitorIcon,
  PlusIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsListCompact, TabsTrigger, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { CaptureSection, useMyCapture } from '@/features/capture/desktop/capture-section';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useDeleteTunnelConnection,
  useTunnelConnections,
  type TunnelConnection,
} from '@/hooks/tunnel/use-tunnel';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  DESKTOP_CAPTURE_SETTINGS_COMMAND,
  desktopComputerAccessGet,
  desktopComputerAccessSet,
  desktopComputerDisconnect,
  desktopComputerGrants,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerRequestGrants,
  desktopComputerResume,
} from '@/lib/desktop';
import { relativeTime } from '@/lib/relative-time';

import {
  CAPABILITIES,
  COMPUTER_SETUP_EVENT,
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
} from './computer-connect';
import { ComputerRow, ComputerSection, GrantState, StatusDot } from './computer-rows';

const DESKTOP_ACCESS_KEY = ['desktop-computer-access'] as const;
const DESKTOP_GRANTS_KEY = ['desktop-computer-grants'] as const;

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

export type ComputerHubTab = 'agents' | 'capture';

const OPEN_COMPUTER_HUB_EVENT = 'kortix:open-computer-hub';

/** Opens "Your computer" at a section. The project shell's `ComputerHubHost` owns the dialog. */
export function openComputerHub(tab: ComputerHubTab = 'agents') {
  window.dispatchEvent(new CustomEvent<ComputerHubTab>(OPEN_COMPUTER_HUB_EVENT, { detail: tab }));
}

/**
 * The one "Your computer" dialog of a project window, mounted by the project
 * shell so it opens whether or not the sidebar is on screen (a narrow window
 * keeps the sidebar closed). Opened by the workspace menu, by the tray's
 * Capture "Settings…" (a desktop command), and right after this computer
 * pairs (`COMPUTER_SETUP_EVENT`).
 */
export function ComputerHubHost({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ComputerHubTab>('agents');
  useEffect(() => {
    const show = (next: ComputerHubTab) => {
      setTab(next);
      setOpen(true);
    };
    const onOpen = (event: Event) => show((event as CustomEvent<ComputerHubTab>).detail ?? 'agents');
    const onSetup = () => show('agents');
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === DESKTOP_CAPTURE_SETTINGS_COMMAND) show('capture');
    };
    window.addEventListener(OPEN_COMPUTER_HUB_EVENT, onOpen);
    window.addEventListener(COMPUTER_SETUP_EVENT, onSetup);
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => {
      window.removeEventListener(OPEN_COMPUTER_HUB_EVENT, onOpen);
      window.removeEventListener(COMPUTER_SETUP_EVENT, onSetup);
      window.removeEventListener('kortix-desktop-command', onCommand);
    };
  }, []);
  // The content mounts on open, so each open starts at `tab`.
  return <LocalComputerModal projectId={projectId} open={open} onOpenChange={setOpen} initialTab={tab} />;
}

/**
 * "Your computer" (desktop app only): one place for this computer, with two
 * independent sections under one header.
 *
 * - Agent access: the computer agent (the tunnel). Pairing, when Kortix may
 *   use it, what it may use, its background service.
 * - My Capture: Kortix Capture on this computer, recording into the current
 *   project. Shown only when this app bundles the engine and the project has
 *   its `capture` flag on.
 *
 * Tabs, not stacked sections: each section has its own primary action in
 * the footer, and the dialog must fit a 720 × 480 window. Turning one on never
 * touches the other.
 */
export function LocalComputerModal({
  projectId,
  open,
  onOpenChange,
  initialTab = 'agents',
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: ComputerHubTab;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* A column: on a short window only the body scrolls; header, tabs and footer stay.
          No initial focus: it is opened by events too (the tray), and a focused
          first control there reads as selected. */}
      <ModalContent className="flex flex-col lg:max-w-lg" onOpenAutoFocus={(event) => event.preventDefault()}>
        {open ? (
          <ComputerHub projectId={projectId} initialTab={initialTab} onClose={() => onOpenChange(false)} />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function ComputerHub({
  projectId,
  initialTab,
  onClose,
}: {
  projectId: string;
  initialTab: ComputerHubTab;
  onClose: () => void;
}) {
  const t = useTranslations('computers');
  const agent = useThisComputerState({ poll: true });
  const capture = useMyCapture(projectId, { poll: true });
  const [tab, setTab] = useState<ComputerHubTab>(initialTab);
  const active: ComputerHubTab = capture.visible ? tab : 'agents';
  const paired = Boolean(agent.tunnelId && agent.state);
  // The machine's name once paired; until then "This computer", without the badge that says the same.
  const machineName = paired ? computerDisplayName(agent.machine?.name, agent.machine?.machineInfo) : '';
  const name = machineName || t('thisComputer');
  const agentState: ComputerState | null = paired ? (agent.state ?? 'offline') : null;

  return (
    <>
      <ModalHeader className="flex-row items-center gap-3 pr-12">
        <ComputerGlyph />
        <div className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <ModalTitle className="truncate">{name}</ModalTitle>
            {machineName ? (
              <Badge variant="outline" size="xs" className="shrink-0">
                {t('thisComputerBadge')}
              </Badge>
            ) : null}
          </div>
          <ModalDescription className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
            <HeaderStatus
              label={t('hub.agents')}
              dot={agentState ? <ComputerStateDot state={agentState} /> : <StatusDot tone="idle" />}
              word={agentState ? t(`state.${agentState}`) : t('notConnected')}
            />
            {capture.visible ? (
              <>
                <span aria-hidden>·</span>
                <HeaderStatus label={t('hub.capture')} dot={<StatusDot tone={capture.tone} />} word={capture.word} />
              </>
            ) : null}
          </ModalDescription>
        </div>
      </ModalHeader>

      {capture.visible ? (
        <Tabs value={active} onValueChange={(next) => setTab(next as ComputerHubTab)} className="px-5">
          <TabsList type="underline" className="w-full justify-start gap-5">
            <TabsTrigger value="agents" className="w-fit flex-none px-0">
              {t('hub.tabAgents')}
            </TabsTrigger>
            <TabsTrigger value="capture" className="w-fit flex-none px-0">
              {t('hub.tabCapture')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {active === 'capture' ? (
        <CaptureSection projectId={projectId} onClose={onClose} />
      ) : (
        <AgentAccess projectId={projectId} onClose={onClose} />
      )}
    </>
  );
}

function HeaderStatus({ label, dot, word }: { label: string; dot: ReactNode; word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span>{label}</span>
      {dot}
      <span className="text-foreground">{word}</span>
    </span>
  );
}

/** Agent access: the computer agent's pairing, access, capabilities and service. */
function AgentAccess({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('computers');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { desktop, status, tunnelId, machine, state, stale } = useThisComputerState({ poll: true });
  const { connectorAlias, connections } = useProjectComputerAccounts(projectId);
  const connect = useConnectDesktopComputer(projectId);
  const deleteMachine = useDeleteTunnelConnection();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const access = useComputerAccess();
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

  if (desktop.isPending) {
    return (
      <ModalBody>
        <Loading className="size-4 shrink-0" />
      </ModalBody>
    );
  }

  if (!status?.available) {
    return (
      <ModalBody>
        <p className="text-muted-foreground text-sm text-pretty">{status?.error || t('desktopUnavailable')}</p>
      </ModalBody>
    );
  }

  const paired = Boolean(tunnelId && state);
  if (!paired || state === 'needsReconnect') {
    const reconnect = state === 'needsReconnect';
    return (
      <>
        <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
          {reconnect ? <InfoBanner tone="warning" icon={WarningIcon} title={t('needsReconnectHint')} /> : null}
          <p className="text-muted-foreground text-sm text-pretty">{t('connectDescription')}</p>
          <ComputerSection title={t('capabilitiesTitle')} hint={t('scopeLine')}>
            {CAPABILITIES.map(({ key, icon }) => (
              <ComputerRow
                key={key}
                icon={icon}
                title={t(`capability.${key}`)}
                description={t(`capability.${key}Description`)}
              />
            ))}
          </ComputerSection>
        </ModalBody>
        <ModalFooter className="border-t py-3">
          <Button disabled={connect.isPending} onClick={() => connect.mutate({ reauth: stale || reconnect })}>
            {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {connect.isPending ? t('connecting') : reconnect ? t('connectAgain') : t('connectThisComputer')}
          </Button>
        </ModalFooter>
      </>
    );
  }

  const paused = state === 'paused';
  const lastSeen =
    state === 'offline' && machine?.lastHeartbeatAt ? relativeTime(machine.lastHeartbeatAt, locale) : '';
  const platform = platformName(machine?.machineInfo?.platform);
  const needsSetup = capabilitiesNeedingSetup(grants.data?.missing);
  const granted = machine?.capabilities ?? [];
  const meta = [
    lastSeen ? t('lastSeen', { time: lastSeen }) : '',
    platform && state !== 'offline' ? platform : '',
    user?.email ? t('pairedWith', { email: user.email }) : '',
  ].filter(Boolean);

  return (
    <>
      <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
        {paused ? <p className="text-muted-foreground text-sm text-pretty">{t('hub.pausedHint')}</p> : null}
        <ComputerSetup />
        {access.current?.mode === 'ask' && access.current.pendingRequest ? (
          <AccessRequestBanner capability={access.current.pendingRequest.capability} update={access.update} />
        ) : null}
        {access.current ? <AccessSection access={access.current} now={access.now} update={access.update} /> : null}
        <ComputerSection title={t('capabilitiesTitle')} hint={t('capabilitiesHint')}>
          {CAPABILITIES.map(({ key, icon }) => {
            const allowed = granted.includes(key) && !needsSetup.includes(key);
            const pending = granted.includes(key) && needsSetup.includes(key);
            return (
              <ComputerRow
                key={key}
                icon={icon}
                title={t(`capability.${key}`)}
                description={t(`capability.${key}Description`)}
                trailing={
                  <GrantState
                    allowed={allowed}
                    label={allowed ? t('capability.allowed') : pending ? t('capability.needsSetup') : t('capability.notAllowed')}
                  />
                }
              />
            );
          })}
        </ComputerSection>
        {access.current?.keepAwakeSupported ? (
          <ComputerSection title={t('hub.thisComputer')}>
            <ComputerRow
              icon={BatteryChargingIcon}
              title={t('access.keepAwake')}
              description={t('access.keepAwakeDescription')}
              trailing={
                <Switch
                  checked={access.current.keepAwake}
                  disabled={access.update.isPending}
                  onCheckedChange={(keepAwake) => access.update.mutate({ keepAwake })}
                  aria-label={t('access.keepAwake')}
                />
              }
            />
          </ComputerSection>
        ) : null}
        {meta.length > 0 ? <p className="text-muted-foreground text-xs text-pretty">{meta.join(' · ')}</p> : null}
      </ModalBody>
      <ModalFooter className="border-t py-3 sm:justify-between">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('hub.more')}>
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem
              onSelect={() => void desktopComputerOpenLogs().catch((error: Error) => errorToast(error.message))}
            >
              {t('showLogs')}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                href={`/projects/${projectId}/customize/connectors?c=${encodeURIComponent(manageSlug)}`}
                onClick={onClose}
              >
                {t('manageInProject')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDisconnect(true)}>
              {t('disconnectEllipsis')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant={paused ? 'default' : 'secondary'}
          disabled={toggleService.isPending}
          onClick={() => toggleService.mutate(paused)}
        >
          {toggleService.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {paused ? t('hub.resumeAccess') : t('hub.pauseAccess')}
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
 * needs, asked for with one "Allow access", so no prompt interrupts an agent
 * later. Files need Desktop, Documents, and Downloads; Screen & keyboard needs
 * Accessibility and Screen Recording. All of them go to Kortix. Each row turns
 * "Allowed" as macOS answers; quiet once nothing is missing and nothing was
 * missing while the dialog was open.
 */
function ComputerSetup() {
  const t = useTranslations('computers');
  const grants = useComputerGrants();
  const [asked, setAsked] = useState(false);
  const request = useMutation({
    retry: false,
    mutationFn: desktopComputerRequestGrants,
    onMutate: () => setAsked(true),
    onError: (error: Error) => errorToast(error.message || t('actionFailed')),
    onSettled: () => void grants.refetch(),
  });
  const missing = grants.data?.missing ?? [];
  // Every step that was missing while this dialog was open stays in view, so a
  // step that turns "Allowed" stays. Adjusted during render.
  const [steps, setSteps] = useState<readonly SetupStep[]>([]);
  const added = missing.filter((step) => !steps.includes(step));
  if (added.length > 0) setSteps([...steps, ...added]);
  if (steps.length === 0) return null;
  const done = missing.length === 0;

  return (
    <ComputerSection
      title={done ? t('setup.doneTitle') : t('setup.title')}
      action={
        done ? null : (
          <Button size="sm" disabled={request.isPending} onClick={() => request.mutate()}>
            {request.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('hub.allowAccess')}
          </Button>
        )
      }
      hint={done ? t('setup.doneHint') : asked ? t('setup.settingsHint') : t('setup.hint')}
    >
      {SETUP_STEPS.filter(({ key }) => steps.includes(key)).map(({ key, icon }) => {
        const allowed = !missing.includes(key);
        return (
          <ComputerRow
            key={key}
            icon={icon}
            title={t(`setup.${key}`)}
            description={t(`setup.${key}Description`)}
            trailing={
              <GrantState
                allowed={allowed}
                label={allowed ? t('capability.allowed') : asked ? t('setup.waiting') : t('setup.needed')}
              />
            }
          />
        );
      })}
    </ComputerSection>
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
      title={t(`access.request.${REQUEST_CAPABILITIES.includes(capability) ? capability : 'other'}`)}
    >
      <div className="space-y-2.5">
        <p>{t('access.requestHint')}</p>
        {/* Below the text, not beside it: the title needs the full width. */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ grantMinutes: 60 })}>
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
          <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ deny: true })}>
            {t('access.deny')}
          </Button>
        </div>
      </div>
    </InfoBanner>
  );
}

/** Ask each time · Always · Off, and one line that says what that means now. */
function AccessSection({ access, now, update }: { access: ComputerAccess; now: number; update: AccessUpdate }) {
  const t = useTranslations('computers');
  const grant = activeGrant(access, now);
  const denied =
    access.mode === 'ask' && access.deniedUntil && Date.parse(access.deniedUntil) > now
      ? new Date(access.deniedUntil)
      : null;
  return (
    <section className="space-y-1">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
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
            <span className="text-foreground">{t('access.allowedUntil', { time: clock(grant) })}</span>
            <Button size="xs" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ revoke: true })}>
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
          <DropdownMenuItem variant="destructive" onSelect={onDisconnect}>
            {t('disconnectEllipsis')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
