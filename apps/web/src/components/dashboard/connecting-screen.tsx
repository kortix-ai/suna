'use client';

import { useTranslations } from 'next-intl';

import {
  WarningCircleIcon as AlertCircle,
  ArrowLeftIcon as ArrowLeft,
  ArrowsLeftRightIcon as ArrowLeftRight,
  PowerIcon as Power,
  WifiSlashIcon as WifiOff,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { STAGE_LABELS, type ProvisioningStageInfo } from '@/lib/provisioning-stages';
import { type SandboxRecoveryPhase, useRuntimeConnectionStore } from '@kortix/sdk/react';
import { useAppHome } from '@/lib/onboarding/use-app-home';

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
  hideWorkspacePicker = false,
}: ConnectingScreenProps = {}) {
  const appHome = useAppHome();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const status = useRuntimeConnectionStore((s) => s.status);
  const wasConnected = useRuntimeConnectionStore((s) => s.wasConnected);
  const initialCheckDone = useRuntimeConnectionStore((s) => s.initialCheckDone);
  const reconnectAttempts = useRuntimeConnectionStore((s) => s.reconnectAttempts);
  const disconnectedAt = useRuntimeConnectionStore((s) => s.disconnectedAt);
  const recoveryPhase = useRuntimeConnectionStore((s) => s.recoveryPhase);
  const restartRequestedAt = useRuntimeConnectionStore((s) => s.restartRequestedAt);
  const healthy = useRuntimeConnectionStore((s) => s.healthy);

  const router = useRouter();

  const effectiveProvider = provider;
  const resolvedSandboxId = sandboxId || undefined;

  const runtimeOnlyDegraded = !forceConnecting && healthy === false && status === 'connected';
  const runtimeSummary = 'Runtime services degraded';

  const handleSwitch = () => {
    router.push(backHref || appHome);
  };

  const serverLabel = labelOverride?.trim() || 'workspace';

  // ── Prop-driven modes (explicit caller intent beats store state) ────────

  if (error) {
    return (
      <FullScreenShell showWorkspacePicker={!hideWorkspacePicker}>
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
      <FullScreenShell showWorkspacePicker={!hideWorkspacePicker}>
        <StoppedView label={stopped.name || labelOverride || serverLabel} onBack={handleSwitch} />
      </FullScreenShell>
    );
  }

  if (provisioning) {
    return (
      <FullScreenShell showWorkspacePicker={!hideWorkspacePicker}>
        <ProvisioningView
          label={labelOverride || serverLabel}
          title={title || 'Provisioning workspace'}
          progress={provisioning.progress}
          stageLabel={provisioning.stageLabel}
          stages={provisioning.stages}
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
    !forceConnecting && wasConnected && initialCheckDone && status !== 'connected';

  if (isMidSessionDrop) {
    return (
      <>
        <ReconnectPill status={status} disconnectedAt={disconnectedAt} onSwitch={handleSwitch} />
      </>
    );
  }

  if (runtimeOnlyDegraded) {
    return (
      <>
        <HealthPill
          title={tHardcodedUi.raw(
            'componentsDashboardConnectingScreen.line156JsxAttrTitleRuntimeDegraded',
          )}
          detail={runtimeSummary}
          onSwitch={handleSwitch}
        />
      </>
    );
  }

  if (!forceConnecting && status === 'unreachable') {
    return (
      <>
        <FullScreenShell showWorkspacePicker={!hideWorkspacePicker}>
          <UnreachableView
            label={serverLabel}
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

  return <CompactConnectingSignal title={title} overrideStage={overrideStage} minimal={minimal} />;
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
  /**
   * Compatibility flag for pages that previously hid loader chrome.
   */
  hideWorkspacePicker?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast hook — kept as a no-op compatibility export for older shells.
// ─────────────────────────────────────────────────────────────────────────────

export function useConnectionToasts() {
  // Mid-session connection state now stays in the background and is surfaced
  // exclusively via the reconnect pill in the bottom-right corner. Avoid
  // duplicate toast noise for transient drops and recoveries.
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shell
// ─────────────────────────────────────────────────────────────────────────────

type SandboxConnectionStatus = 'connecting' | 'connected' | 'unreachable';
export type Stage = 'auth' | 'routing' | 'reaching' | 'restoring';

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
  /** Kept for call-site compatibility; loader chrome no longer renders it. */
  showWorkspacePicker?: boolean;
}) {
  return (
    <div className="bg-background fixed inset-0 z-[60] flex items-center justify-center">
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
      className="bg-foreground/[0.06] h-[1.5px] w-[160px] overflow-hidden rounded-full"
      aria-hidden
    >
      <div className="bg-foreground/50 animate-connect-progress h-full w-1/3 rounded-full" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning view — determinate progress, stages, machine info
// ─────────────────────────────────────────────────────────────────────────────

function ProvisioningView({
  label,
  title,
  progress,
  stageLabel,
  stages,
  currentStage,
  machineInfo,
  onBack,
}: {
  label: string;
  title: string;
  progress: number;
  stageLabel?: string;
  stages?: ProvisioningStageInfo[] | null;
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
    stageLabel || (currentStage ? STAGE_LABELS[currentStage] : undefined) || 'Preparing workspace';

  return (
    <>
      <KortixLogo size={40} />

      <p className="text-foreground/55 max-w-[320px] truncate text-sm font-normal">{label}</p>

      <DeterminateProgress pct={pct} />

      <div className="text-muted-foreground/50 flex items-center gap-2 text-xs">
        <span className="font-medium tabular-nums">{Math.round(pct)}%</span>
        <span className="bg-foreground/[0.08] h-[10px] w-px" aria-hidden />
        <span className="max-w-[220px] truncate">{stageText}</span>
      </div>

      {machineInfo?.ip && (
        <div className="text-muted-foreground/35 inline-flex items-center gap-1.5 font-mono text-xs tracking-wide">
          <span className="bg-foreground/40 h-1 w-1 rounded-full" />
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
      className="bg-foreground/[0.06] h-[1.5px] w-[160px] overflow-hidden rounded-full"
      aria-hidden
    >
      <div
        className="bg-foreground/60 h-full rounded-full transition-[width] duration-500 ease-out"
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
        className="border-destructive/20 bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-full border"
        aria-hidden
      >
        <AlertCircle className="text-destructive/70 h-5 w-5" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-foreground/90 text-sm font-medium">
          {tHardcodedUi.raw('componentsDashboardConnectingScreen.line422JsxTextCouldnAposTStart')}{' '}
          {label}
        </h1>
        {(serverType || location) && (
          <p className="text-muted-foreground/35 font-mono text-xs">
            {[serverType, location].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <p className="text-muted-foreground/60 max-w-[320px] text-center text-xs leading-relaxed wrap-break-word">
        {message}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="border-border/40 text-foreground/70 hover:border-border/70 hover:text-foreground inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-4 text-xs font-medium transition-colors"
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

function StoppedView({ label, onBack }: { label: string; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <div
        className="border-border/40 bg-foreground/[0.03] flex h-12 w-12 items-center justify-center rounded-full border"
        aria-hidden
      >
        <Power className="text-muted-foreground/60 h-5 w-5" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-foreground/90 text-sm font-medium">
          {label}
          {tHardcodedUi.raw('componentsDashboardConnectingScreen.line469JsxTextIsStopped')}
        </h1>
        <p className="text-muted-foreground/55 max-w-[300px] text-center text-xs leading-relaxed">
          {tHardcodedUi.raw(
            'componentsDashboardConnectingScreen.line472JsxTextOpenANewSessionOrReturnToProjects',
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border-border/40 text-foreground/70 hover:border-border/70 hover:text-foreground inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-4 text-xs font-medium transition-colors"
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
      className="text-muted-foreground/35 hover:text-foreground/70 fixed top-5 left-5 inline-flex cursor-pointer items-center gap-1.5 text-xs transition-colors"
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
  label,
  reconnectAttempts,
  provider,
  recoveryPhase,
  restartRequestedAt,
  degraded,
  onSwitch,
  sandboxId,
}: {
  label: string;
  reconnectAttempts: number;
  provider?: string;
  recoveryPhase: SandboxRecoveryPhase;
  restartRequestedAt: number | null;
  degraded?: boolean;
  onSwitch: () => void;
  sandboxId?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isRestartRecovering = recoveryPhase !== 'idle';
  const secondsSinceRestart = restartRequestedAt
    ? Math.max(1, Math.floor((Date.now() - restartRequestedAt) / 1000))
    : null;

  return (
    <>
      <div
        className="border-destructive/20 bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-full border"
        aria-hidden
      >
        <WifiOff className="text-destructive/70 h-5 w-5" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-foreground/90 text-sm font-medium">
          {recoveryPhase === 'restarting_host'
            ? 'Rebooting host'
            : recoveryPhase === 'restarting_runtime'
              ? 'Restarting runtime services'
              : recoveryPhase === 'restarting_workload'
                ? 'Restarting workload'
                : degraded
                  ? 'Workspace services unavailable'
                  : 'Workspace offline'}
        </h1>
        <p className="text-muted-foreground/55 max-w-[300px] text-center text-xs leading-relaxed">
          {recoveryPhase === 'restarting_host'
            ? 'The host reboot was accepted. Waiting for the machine and services to come back online.'
            : recoveryPhase === 'restarting_runtime'
              ? 'The runtime restart was accepted. Waiting for core services to come back online.'
              : recoveryPhase === 'restarting_workload'
                ? 'The workload restart was accepted. Waiting for the container and core services to come back online.'
                : degraded
                  ? 'The host is reachable, but the core workspace runtime is failing requests. Restart the runtime or workload to recover services.'
                  : 'This workspace is unreachable. Return to projects and open or create another session.'}
        </p>
        {sandboxId ? (
          <p className="text-muted-foreground/35 font-mono text-xs">
            Sandbox {sandboxId.slice(0, 8)}
          </p>
        ) : null}
        {isRestartRecovering && secondsSinceRestart ? (
          <p className="text-muted-foreground/35 font-mono text-xs">
            {tHardcodedUi.raw('componentsDashboardConnectingScreen.line564JsxTextRecovering')}
            {secondsSinceRestart}s
          </p>
        ) : null}
      </div>

      <div className="text-muted-foreground/45 inline-flex items-center gap-1.5 text-xs">
        <Loading className="h-3 w-3" />
        <span>
          {recoveryPhase === 'restarting_host'
            ? 'Waiting for host and services'
            : recoveryPhase === 'restarting_runtime'
              ? 'Waiting for core runtime'
              : recoveryPhase === 'restarting_workload'
                ? 'Waiting for workload and services'
                : 'Retrying automatically'}
        </span>
        {reconnectAttempts > 0 && !isRestartRecovering && (
          <span className="text-muted-foreground/35 font-mono tabular-nums">
            · {reconnectAttempts}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSwitch}
          className="border-border/40 text-foreground/70 hover:border-border/70 hover:text-foreground inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-4 text-xs font-medium transition-colors"
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
  const label = status === 'unreachable' ? 'Unreachable' : 'Reconnecting';

  return (
    <div className="animate-in slide-in-from-bottom-3 fade-in fixed right-6 bottom-6 z-[60] duration-300">
      <div className="border-border/50 bg-background/95 flex items-center gap-2.5 rounded-full border py-1.5 pr-1.5 pl-3 shadow-lg shadow-black/5 backdrop-blur-xl">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {label}
          {elapsed ? <span className="text-muted-foreground/40"> · {elapsed}</span> : null}
        </span>

        <Button type="button" onClick={onSwitch} variant="muted" size="xs" className="rounded-full">
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
    <div className="animate-in slide-in-from-bottom-3 fade-in fixed right-6 bottom-6 z-[60] duration-300">
      <div className="border-border/50 bg-background/95 flex items-center gap-2.5 rounded-full border py-1.5 pr-1.5 pl-3 shadow-lg shadow-black/5 backdrop-blur-xl">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <span className="text-muted-foreground max-w-[220px] truncate text-xs whitespace-nowrap">
          {title}
          {detail ? <span className="text-muted-foreground/40"> · {detail}</span> : null}
        </span>

        <Button type="button" onClick={onSwitch} variant="muted" size="xs" className="rounded-full">
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
