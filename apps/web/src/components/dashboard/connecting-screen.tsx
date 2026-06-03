'use client';

import { useTranslations } from 'next-intl';

import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  Power,
  RefreshCw,
  WifiOff,
} from 'lucide-react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import {
  STAGE_LABELS,
  type ProvisioningStageInfo,
} from '@/lib/provisioning-stages';
import { type SandboxRecoveryPhase, useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useServerStore } from '@/stores/server-store';

/**
 * ConnectingScreen — canonical lightweight loader for auth, project routing,
 * and project-session connectivity.
 *
 * Modes (determined by props, and fall back to the sandbox-connection store
 * for the dashboard case):
 *
 *   - `forceConnecting`: always show the connecting view (pre-store gate)
 *   - `provisioning`:    determinate progress + stage, for sandbox boot
 *   - `error`:           red error state with retry actions
 *   - `stopped`:         neutral "workspace stopped" state
 *   - (none provided):   derive from sandbox connection store
 *       • connected                            → null
 *       • was connected, still alive-ish       → floating ReconnectPill
 *       • unreachable + never connected before → full-screen Unreachable
 *       • default                              → full-screen Connecting
 */
export function ConnectingScreen({
  forceConnecting = false,
  overrideStage,
  title,
  labelOverride,
  provisioning,
  error,
  stopped,
  sandboxId,
  provider,
  backHref,
  minimal = false,
}: ConnectingScreenProps = {}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const status = useSandboxConnectionStore((s) => s.status);
  const wasConnected = useSandboxConnectionStore((s) => s.wasConnected);
  const initialCheckDone = useSandboxConnectionStore((s) => s.initialCheckDone);
  const reconnectAttempts = useSandboxConnectionStore((s) => s.reconnectAttempts);
  const disconnectedAt = useSandboxConnectionStore((s) => s.disconnectedAt);
  const recoveryPhase = useSandboxConnectionStore((s) => s.recoveryPhase);
  const restartRequestedAt = useSandboxConnectionStore((s) => s.restartRequestedAt);
  const healthy = useSandboxConnectionStore((s) => s.healthy);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === activeServerId);

  const router = useRouter();

  const effectiveProvider = provider || activeServer?.provider;
  const resolvedSandboxId = sandboxId || activeServer?.instanceId || undefined;

  const runtimeOnlyDegraded = !forceConnecting && healthy === false && status === 'connected';
  const runtimeSummary = 'Runtime services degraded';

  const handleSwitch = () => {
    router.push(backHref || '/projects');
  };

  const serverLabel =
    labelOverride?.trim() || activeServer?.label?.trim() || 'workspace';

  // ── Prop-driven modes (explicit caller intent beats store state) ────────

  if (error) {
    return (
      <FullScreenShell>
        <ErrorView
          label={labelOverride || serverLabel}
          message={error.message}
          location={error.location}
          serverType={error.serverType}
          onBack={handleSwitch}
        />
      </FullScreenShell>
    );
  }

  if (stopped) {
    return (
      <FullScreenShell>
        <StoppedView
          label={stopped.name || labelOverride || serverLabel}
          onBack={handleSwitch}
        />
      </FullScreenShell>
    );
  }

  if (provisioning) {
    return (
      <FullScreenShell>
        <ProvisioningView
          label={labelOverride || serverLabel}
          progress={provisioning.progress}
          stageLabel={provisioning.stageLabel}
          currentStage={provisioning.currentStage}
          machineInfo={provisioning.machineInfo}
          onBack={handleSwitch}
        />
      </FullScreenShell>
    );
  }

  // ── Store-driven modes (used by the dashboard overlay) ──────────────────

  if (!forceConnecting && status === 'connected' && healthy !== false) return null;

  const isMidSessionDrop =
    !forceConnecting &&
    wasConnected &&
    initialCheckDone &&
    status !== 'connected';

  if (isMidSessionDrop) {
    return (
      <>
        <ReconnectPill
          status={status}
          disconnectedAt={disconnectedAt}
          onSwitch={handleSwitch}
        />
      </>
    );
  }

  if (runtimeOnlyDegraded) {
    return (
      <>
        <HealthPill
          title={tHardcodedUi.raw('componentsDashboardConnectingScreen.line156JsxAttrTitleRuntimeDegraded')}
          detail={runtimeSummary}
          onSwitch={handleSwitch}
        />
      </>
    );
  }

  if (!forceConnecting && status === 'unreachable') {
    return (
      <>
        <FullScreenShell>
          <UnreachableView
            reconnectAttempts={reconnectAttempts}
            provider={effectiveProvider}
            recoveryPhase={recoveryPhase}
            restartRequestedAt={restartRequestedAt}
            degraded={false}
            onSwitch={handleSwitch}
            sandboxId={resolvedSandboxId}
          />
        </FullScreenShell>
      </>
    );
  }

  return (
    <CompactConnectingSignal
      title={title}
      overrideStage={overrideStage}
      minimal={minimal}
    />
  );
}

export interface ConnectingScreenProps {
  /** Force the connecting view regardless of store state (dashboard gate). */
  forceConnecting?: boolean;
  /** Pin the stage label (Auth / Routing / Reaching / Restoring). */
  overrideStage?: Stage;
  /** Override the screen headline (e.g. "Provisioning workspace"). */
  title?: string;
  /** Override the workspace label when the server store is not populated yet. */
  labelOverride?: string;
  /** Determinate provisioning mode — shows real progress + stages. */
  provisioning?: {
    progress: number;
    stageLabel?: string;
    stages?: ProvisioningStageInfo[] | null;
    currentStage?: string | null;
    machineInfo?: {
      ip: string;
      serverType: string;
      location: string;
    } | null;
  };
  /** Error state — workspace failed to provision or is otherwise broken. */
  error?: {
    message: string;
    serverType?: string;
    location?: string;
  };
  /** Stopped state — workspace exists but is not running. */
  stopped?: {
    name?: string;
  };
  sandboxId?: string;
  provider?: string;
  /** Where "Back" / switch buttons should navigate. */
  backHref?: string;
  /**
   * Minimal mode for auth / OAuth consent gates where no workspace context exists.
   * Normal connecting waits render only the top progress line.
   */
  minimal?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shell
// ─────────────────────────────────────────────────────────────────────────────

type SandboxConnectionStatus = 'connecting' | 'connected' | 'unreachable';
type Stage = 'auth' | 'routing' | 'reaching' | 'restoring';

const STAGE_COPY: Record<Stage, string> = {
  auth: 'Authenticating',
  routing: 'Connecting',
  reaching: 'Reaching workspace',
  restoring: 'Restoring session',
};

function FullScreenShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="relative z-10 flex w-full max-w-[420px] flex-col items-center gap-8 px-8">
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connecting signal — initial load, in-app switch, first-time connect
// ─────────────────────────────────────────────────────────────────────────────

function CompactConnectingSignal({
  title,
  overrideStage,
  minimal = false,
}: {
  title?: string;
  overrideStage?: Stage;
  minimal?: boolean;
}) {
  const status = title || (!minimal && overrideStage ? STAGE_COPY[overrideStage] : 'Connecting');

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
      role="status"
      aria-label={status}
    >
      <ProgressLine />
    </div>
  );
}

/** Hairline indeterminate progress bar — our single, canonical "working" signal. */
function ProgressLine() {
  return (
    <div
      className="h-[1.5px] w-[160px] overflow-hidden rounded-full bg-foreground/[0.06]"
      aria-hidden
    >
      <div className="h-full w-1/3 rounded-full bg-foreground/50 animate-connect-progress" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning view — determinate progress, stages, machine info
// ─────────────────────────────────────────────────────────────────────────────

function ProvisioningView({
  label,
  progress,
  stageLabel,
  currentStage,
  machineInfo,
  onBack,
}: {
  label: string;
  progress: number;
  stageLabel?: string;
  currentStage?: string | null;
  machineInfo?: {
    ip: string;
    serverType: string;
    location: string;
  } | null;
  onBack: () => void;
}) {
  const pct = Math.max(0, Math.min(100, progress));
  const stageText =
    stageLabel ||
    (currentStage ? STAGE_LABELS[currentStage] : undefined) ||
    'Preparing workspace';

  return (
    <>
      <KortixLogo size={40} />

      <p className="text-sm font-normal text-foreground/55 max-w-[320px] truncate">
        {label}
      </p>

      <DeterminateProgress pct={pct} />

      <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
        <span className="tabular-nums font-medium">{Math.round(pct)}%</span>
        <span className="h-[10px] w-px bg-foreground/[0.08]" aria-hidden />
        <span className="max-w-[220px] truncate">{stageText}</span>
      </div>

      {machineInfo?.ip && (
        <div className="inline-flex items-center gap-1.5 text-xs font-mono tracking-wide text-muted-foreground/35">
          <span className="h-1 w-1 rounded-full bg-foreground/40" />
          {machineInfo.location?.toLowerCase().match(/us|hil/) ? 'US' : 'EU'}
          <span>·</span>
          {machineInfo.ip}
        </div>
      )}

      <BackLink onClick={onBack} />
    </>
  );
}

/** Determinate progress line — same geometry as the indeterminate one. */
function DeterminateProgress({ pct }: { pct: number }) {
  return (
    <div
      className="h-[1.5px] w-[160px] overflow-hidden rounded-full bg-foreground/[0.06]"
      aria-hidden
    >
      <div
        className="h-full rounded-full bg-foreground/60 transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(pct, 2)}%` }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error view — provisioning failed
// ─────────────────────────────────────────────────────────────────────────────

function ErrorView({
  label,
  message,
  location,
  serverType,
  onBack,
}: {
  label: string;
  message: string;
  location?: string;
  serverType?: string;
  onBack: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10"
        aria-hidden
      >
        <AlertCircle className="h-5 w-5 text-destructive/70" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-sm font-medium text-foreground/90">{tHardcodedUi.raw('componentsDashboardConnectingScreen.line422JsxTextCouldnAposTStart')}{' '}{label}
        </h1>
        {(serverType || location) && (
          <p className="font-mono text-xs text-muted-foreground/35">
            {[serverType, location].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <p className="max-w-[320px] text-center text-xs leading-relaxed text-muted-foreground/60 break-words">
        {message}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-xs font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stopped view — workspace exists but is not running
// ─────────────────────────────────────────────────────────────────────────────

function StoppedView({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-border/40 bg-foreground/[0.03]"
        aria-hidden
      >
        <Power className="h-5 w-5 text-muted-foreground/60" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-sm font-medium text-foreground/90">
          {label}{tHardcodedUi.raw('componentsDashboardConnectingScreen.line469JsxTextIsStopped')}</h1>
        <p className="max-w-[300px] text-center text-xs leading-relaxed text-muted-foreground/55">{tHardcodedUi.raw('componentsDashboardConnectingScreen.line472JsxTextOpenANewSessionOrReturnToProjects')}</p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-xs font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
        >
          <ArrowLeft className="h-3 w-3" />
          Back
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fragments
// ─────────────────────────────────────────────────────────────────────────────

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed left-5 top-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground/35 transition-colors hover:text-foreground/70 cursor-pointer"
    >
      <ArrowLeft className="h-3 w-3" />
      Back
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unreachable view — health checks failed past threshold
// ─────────────────────────────────────────────────────────────────────────────

function UnreachableView({
  reconnectAttempts,
  provider,
  recoveryPhase,
  restartRequestedAt,
  degraded,
  onSwitch,
  sandboxId,
}: {
  reconnectAttempts: number;
  provider?: string;
  recoveryPhase: SandboxRecoveryPhase;
  restartRequestedAt: number | null;
  degraded?: boolean;
  onSwitch: () => void;
  sandboxId?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isLocalDocker = provider === 'local_docker';
  const isRestartRecovering = recoveryPhase !== 'idle';
  const secondsSinceRestart = restartRequestedAt ? Math.max(1, Math.floor((Date.now() - restartRequestedAt) / 1000)) : null;

  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10"
        aria-hidden
      >
        <WifiOff className="h-5 w-5 text-destructive/70" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-sm font-medium text-foreground/90">
          {isLocalDocker ? 'Local sandbox unreachable' : recoveryPhase === 'restarting_host' ? 'Rebooting host' : recoveryPhase === 'restarting_runtime' ? 'Restarting runtime services' : recoveryPhase === 'restarting_workload' ? 'Restarting workload' : degraded ? 'Workspace services unavailable' : 'Workspace offline'}
        </h1>
        <p className="max-w-[300px] text-center text-xs leading-relaxed text-muted-foreground/55">
          {isLocalDocker
            ? 'Make sure Docker is running and the container has started.'
            : recoveryPhase === 'restarting_host'
              ? 'The host reboot was accepted. Waiting for the machine and services to come back online.'
              : recoveryPhase === 'restarting_runtime'
                ? 'The runtime restart was accepted. Waiting for core services to come back online.'
              : recoveryPhase === 'restarting_workload'
                ? 'The workload restart was accepted. Waiting for the container and core services to come back online.'
              : degraded
                ? 'The host is reachable, but the core workspace runtime is failing requests. Restart the runtime or workload to recover services.'
              : 'This workspace is unreachable. Return to projects and open or create another session.'}
        </p>
        {!isLocalDocker && sandboxId ? (
          <p className="text-xs font-mono text-muted-foreground/35">Sandbox {sandboxId.slice(0, 8)}</p>
        ) : null}
        {!isLocalDocker && isRestartRecovering && secondsSinceRestart ? (
          <p className="text-xs font-mono text-muted-foreground/35">{tHardcodedUi.raw('componentsDashboardConnectingScreen.line564JsxTextRecovering')}{secondsSinceRestart}s</p>
        ) : null}
      </div>

      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/45">
        <RefreshCw className="h-3 w-3 animate-spin" />
        <span>
          {recoveryPhase === 'restarting_host' ? 'Waiting for host and services' : recoveryPhase === 'restarting_runtime' ? 'Waiting for core runtime' : recoveryPhase === 'restarting_workload' ? 'Waiting for workload and services' : 'Retrying automatically'}
        </span>
        {reconnectAttempts > 0 && !isRestartRecovering && (
          <span className="font-mono tabular-nums text-muted-foreground/35">
            · {reconnectAttempts}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSwitch}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-xs font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
        >
          <ArrowLeftRight className="h-3 w-3" />
          Projects
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnect pill — non-blocking, mid-session drop
// ─────────────────────────────────────────────────────────────────────────────

function ReconnectPill({
  status,
  disconnectedAt,
  onSwitch,
}: {
  status: SandboxConnectionStatus;
  disconnectedAt: number | null;
  onSwitch: () => void;
}) {
  const elapsed = useElapsedTime(disconnectedAt);
  const label = status === 'unreachable'
      ? 'Unreachable'
      : 'Reconnecting';

  return (
    <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-3 fade-in duration-300">
      <div className="flex items-center gap-2.5 rounded-full border border-border/50 bg-background/95 pl-3 pr-1.5 py-1.5 shadow-lg shadow-black/5 backdrop-blur-xl">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {label}
          {elapsed ? (
            <span className="text-muted-foreground/40"> · {elapsed}</span>
          ) : null}
        </span>

        <Button
          type="button"
          onClick={onSwitch}
          variant="muted"
          size="xs"
          className="rounded-full"
        >
          <ArrowLeftRight className="h-2.5 w-2.5" />
          Projects
        </Button>
      </div>
    </div>
  );
}

function HealthPill({
  title,
  detail,
  onSwitch,
}: {
  title: string;
  detail?: string;
  onSwitch: () => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-3 fade-in duration-300">
      <div className="flex items-center gap-2.5 rounded-full border border-border/50 bg-background/95 pl-3 pr-1.5 py-1.5 shadow-lg shadow-black/5 backdrop-blur-xl">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <span className="max-w-[220px] truncate whitespace-nowrap text-xs text-muted-foreground">
          {title}
          {detail ? <span className="text-muted-foreground/40"> · {detail}</span> : null}
        </span>

        <Button
          type="button"
          onClick={onSwitch}
          variant="muted"
          size="xs"
          className="rounded-full"
        >
          <ArrowLeftRight className="h-2.5 w-2.5" />
          Projects
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: human-readable elapsed time for the pill
// ─────────────────────────────────────────────────────────────────────────────

function useElapsedTime(since: number | null): string | null {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!since) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [since]);

  return useMemo(() => {
    if (!since) return null;
    const seconds = Math.floor((now - since) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }, [since, now]);
}
