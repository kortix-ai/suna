'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  Power,
  RefreshCw,
  RotateCw,
  WifiOff,
} from 'lucide-react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { restartSandbox } from '@/lib/platform-client';
import {
  STAGE_LABELS,
  type ProvisioningStageInfo,
} from '@/lib/provisioning-stages';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useServerStore } from '@/stores/server-store';

/**
 * ConnectingScreen — THE single, canonical loader used everywhere in the
 * instance/auth/dashboard flow. It replaces every legacy variant:
 *   - the old `DashboardSkeleton` inline
 *   - the old `FirstConnectContent` full-screen overlay
 *   - `LocalProvisioningView` + `WakingInstanceView` in `/instances/[id]`
 *   - the loose `<Loader2>` spinners in `/instances` and `/instances/[id]/*`
 *   - `ProvisioningProgress`
 *
 * One component, one visual language, used as both an early-return and an
 * in-tree overlay. Same mount point wherever possible so there is never a
 * flicker between two different loading UIs.
 *
 * Modes (determined by props, and fall back to the sandbox-connection store
 * for the dashboard case):
 *
 *   - `forceConnecting`: always show the connecting view (pre-store gate)
 *   - `provisioning`:    determinate progress + stage, for sandbox boot
 *   - `error`:           red error state with retry actions
 *   - `stopped`:         neutral "instance stopped" state
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
  backHref,
  minimal = false,
}: ConnectingScreenProps = {}) {
  const status = useSandboxConnectionStore((s) => s.status);
  const wasConnected = useSandboxConnectionStore((s) => s.wasConnected);
  const initialCheckDone = useSandboxConnectionStore((s) => s.initialCheckDone);
  const reconnectAttempts = useSandboxConnectionStore((s) => s.reconnectAttempts);
  const disconnectedAt = useSandboxConnectionStore((s) => s.disconnectedAt);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === activeServerId);

  const router = useRouter();
  const [restarting, setRestarting] = useState(false);

  const isCloudProvider =
    activeServer?.provider && activeServer.provider !== 'local_docker';

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await restartSandbox();
      toast.success('Machine restart initiated. Reconnecting…', {
        duration: 5000,
      });
    } catch (err) {
      toast.error(
        `Restart failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        { duration: 5000 },
      );
    } finally {
      setTimeout(() => setRestarting(false), 15_000);
    }
  }, [restarting]);

  const handleSwitch = useCallback(
    () => router.push(backHref || '/instances'),
    [router, backHref],
  );

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

  if (!forceConnecting && status === 'connected') return null;

  const isMidSessionDrop =
    !forceConnecting &&
    wasConnected &&
    initialCheckDone &&
    status !== 'connected';

  if (isMidSessionDrop) {
    return (
      <ReconnectPill
        status={status}
        disconnectedAt={disconnectedAt}
        onSwitchInstance={handleSwitch}
        onRestart={isCloudProvider ? handleRestart : undefined}
        restarting={restarting}
      />
    );
  }

  if (!forceConnecting && status === 'unreachable') {
    return (
      <FullScreenShell>
        <UnreachableView
          label={serverLabel}
          reconnectAttempts={reconnectAttempts}
          provider={activeServer?.provider}
          restarting={restarting}
          onRestart={isCloudProvider ? handleRestart : undefined}
          onSwitch={handleSwitch}
        />
      </FullScreenShell>
    );
  }

  return (
    <FullScreenShell>
      <ConnectingView
        label={labelOverride || serverLabel}
        title={title}
        overrideStage={overrideStage}
        onSwitch={handleSwitch}
        onRestart={isCloudProvider ? handleRestart : undefined}
        restarting={restarting}
        minimal={minimal}
      />
    </FullScreenShell>
  );
}

export interface ConnectingScreenProps {
  /** Force the connecting view regardless of store state (dashboard gate). */
  forceConnecting?: boolean;
  /** Pin the stage label (Auth / Routing / Reaching / Restoring). */
  overrideStage?: Stage;
  /** Override the screen headline (e.g. "Provisioning workspace"). */
  title?: string;
  /** Override the instance label (when the server store isn't populated yet). */
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
  /** Error state — instance failed to provision or is otherwise broken. */
  error?: {
    message: string;
    serverType?: string;
    location?: string;
  };
  /** Stopped state — instance exists but is not running. */
  stopped?: {
    name?: string;
  };
  /** Where "Back" / "Switch instance" buttons should navigate. */
  backHref?: string;
  /**
   * Minimal mode — hides the "Connecting to <instance>" label entirely.
   * Used for auth / OAuth consent gates where no instance context exists.
   * The component renders only: logo, optional `title`, and the progress
   * line. No stage text, no escape hatch.
   */
  minimal?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast hook — unchanged behaviour, still exported for layout-content.tsx.
// ─────────────────────────────────────────────────────────────────────────────

export function useConnectionToasts() {
  const status = useSandboxConnectionStore((s) => s.status);
  const wasConnected = useSandboxConnectionStore((s) => s.wasConnected);
  const initialCheckDone = useSandboxConnectionStore(
    (s) => s.initialCheckDone,
  );

  const prevStatusRef = useRef<SandboxConnectionStatus | null>(null);

  useEffect(() => {
    if (!initialCheckDone) return;

    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === null) return;

    if (
      prev === 'connected' &&
      (status === 'unreachable' || status === 'connecting') &&
      wasConnected
    ) {
      toast.error('Instance connection lost. Reconnecting…', {
        duration: 4000,
      });
    }

    if (
      (prev === 'unreachable' || prev === 'connecting') &&
      status === 'connected' &&
      wasConnected
    ) {
      toast.success('Instance reconnected!', { duration: 3000 });
    }
  }, [status, wasConnected, initialCheckDone]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shell
// ─────────────────────────────────────────────────────────────────────────────

type SandboxConnectionStatus = 'connecting' | 'connected' | 'unreachable';
export type Stage = 'auth' | 'routing' | 'reaching' | 'restoring';

const STAGE_COPY: Record<Stage, string> = {
  auth: 'Authenticating',
  routing: 'Locating instance',
  reaching: 'Reaching workspace',
  restoring: 'Restoring session',
};

function FullScreenShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="relative z-10 flex w-full max-w-[420px] flex-col items-center gap-8 px-8">
        {children}
      </div>
      <SupportFooter />
    </div>
  );
}

/**
 * Support footer pinned to the bottom of the viewport. Lives outside the
 * centered flex column so it never affects the vertical rhythm of the main
 * content, yet stays visible on every variant.
 */
function SupportFooter() {
  return (
    <p className="pointer-events-auto absolute bottom-7 left-0 right-0 text-center text-[12px] text-muted-foreground/60">
      Having trouble? Contact{' '}
      <a
        href="mailto:support@kortix.com"
        className="font-medium text-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        support@kortix.com
      </a>
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connecting view — initial load, in-app switch, first-time connect
// ─────────────────────────────────────────────────────────────────────────────

function ConnectingView({
  label,
  title,
  overrideStage,
  onSwitch,
  onRestart,
  restarting = false,
  minimal = false,
}: {
  label: string;
  title?: string;
  overrideStage?: Stage;
  onSwitch: () => void;
  onRestart?: () => void;
  restarting?: boolean;
  minimal?: boolean;
}) {
  const [slowHint, setSlowHint] = useState(false);

  useEffect(() => {
    if (minimal) return;
    const t = setTimeout(() => setSlowHint(true), 10_000);
    return () => clearTimeout(t);
  }, [minimal]);

  // Resolve the single line shown beneath the logo.
  // - If `title` is given (e.g. "Signing in", "Provisioning workspace"), use it.
  // - Else if we know the stage, use its copy.
  // - Else fall back to the instance label.
  // In minimal mode we always prefer the title.
  let line: string | null = null;
  if (minimal) line = title ?? null;
  else if (title) line = title;
  else if (overrideStage) line = STAGE_COPY[overrideStage];
  else line = label;

  return (
    <>
      <KortixLogo size={40} />

      {line && (
        <p className="text-[13px] font-normal text-foreground/55 max-w-[320px] truncate">
          {line}
        </p>
      )}

      <ProgressLine />

      {!minimal && onRestart && (
        <Button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          variant="muted"
          size="sm"
          className="rounded-full"
        >
          <RotateCw className={cn('h-3.5 w-3.5', restarting && 'animate-spin')} />
          {restarting ? 'Restarting…' : 'Restart'}
        </Button>
      )}

      {slowHint && !minimal && (
        <button
          type="button"
          onClick={onSwitch}
          className="text-[11px] text-muted-foreground/40 transition-colors hover:text-foreground/70 cursor-pointer"
        >
          Taking longer than usual — switch instance
        </button>
      )}
    </>
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
    stageLabel ||
    (currentStage ? STAGE_LABELS[currentStage] : undefined) ||
    'Preparing workspace';

  return (
    <>
      <KortixLogo size={40} />

      <p className="text-[13px] font-normal text-foreground/55 max-w-[320px] truncate">
        {label}
      </p>

      <DeterminateProgress pct={pct} />

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50">
        <span className="tabular-nums font-medium">{Math.round(pct)}%</span>
        <span className="h-[10px] w-px bg-foreground/[0.08]" aria-hidden />
        <span className="max-w-[220px] truncate">{stageText}</span>
      </div>

      {machineInfo?.ip && (
        <div className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-wide text-muted-foreground/35">
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
  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10"
        aria-hidden
      >
        <AlertCircle className="h-5 w-5 text-destructive/70" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-[14px] font-medium text-foreground/90">
          Couldn&apos;t start {label}
        </h1>
        {(serverType || location) && (
          <p className="font-mono text-[10px] text-muted-foreground/35">
            {[serverType, location].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-muted-foreground/60 break-words">
        {message}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-[12px] font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to instances
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stopped view — instance exists but is not running
// ─────────────────────────────────────────────────────────────────────────────

function StoppedView({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-border/40 bg-foreground/[0.03]"
        aria-hidden
      >
        <Power className="h-5 w-5 text-muted-foreground/60" />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="text-[14px] font-medium text-foreground/90">
          {label} is stopped
        </h1>
        <p className="max-w-[300px] text-center text-[12px] leading-relaxed text-muted-foreground/55">
          Start it again from the instance manager to continue.
        </p>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-[12px] font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to instances
      </button>
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
      className="fixed left-5 top-5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/35 transition-colors hover:text-foreground/70 cursor-pointer"
    >
      <ArrowLeft className="h-3 w-3" />
      Instances
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
  restarting,
  onRestart,
  onSwitch,
}: {
  label: string;
  reconnectAttempts: number;
  provider?: string;
  restarting: boolean;
  onRestart?: () => void;
  onSwitch: () => void;
}) {
  const isLocalDocker = provider === 'local_docker';

  return (
    <>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10"
        aria-hidden
      >
        <WifiOff className="h-5 w-5 text-destructive/70" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-[14px] font-medium text-foreground/90">
          {isLocalDocker ? 'Local sandbox unreachable' : `Can't reach ${label}`}
        </h1>
        <p className="max-w-[300px] text-center text-[12px] leading-relaxed text-muted-foreground/55">
          {isLocalDocker
            ? 'Make sure Docker is running and the container has started.'
            : 'It may be starting up or temporarily offline.'}
        </p>
      </div>

      <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/45">
        {restarting ? (
          <RotateCw className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3 animate-spin" />
        )}
        <span>
          {restarting ? 'Restarting machine' : 'Retrying automatically'}
        </span>
        {reconnectAttempts > 0 && !restarting && (
          <span className="font-mono tabular-nums text-muted-foreground/35">
            · {reconnectAttempts}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {onRestart && (
          <button
            type="button"
            onClick={onRestart}
            disabled={restarting}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-[12px] font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            <RotateCw
              className={cn('h-3 w-3', restarting && 'animate-spin')}
            />
            {restarting ? 'Restarting' : 'Restart'}
          </button>
        )}
        <button
          type="button"
          onClick={onSwitch}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/40 px-4 text-[12px] font-medium text-foreground/70 transition-colors hover:border-border/70 hover:text-foreground cursor-pointer"
        >
          <ArrowLeftRight className="h-3 w-3" />
          Switch instance
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
  onSwitchInstance,
  onRestart,
  restarting,
}: {
  status: SandboxConnectionStatus;
  disconnectedAt: number | null;
  onSwitchInstance: () => void;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const elapsed = useElapsedTime(disconnectedAt);
  const label = restarting
    ? 'Restarting'
    : status === 'unreachable'
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
          {elapsed && !restarting && (
            <span className="text-muted-foreground/40"> · {elapsed}</span>
          )}
        </span>

        {onRestart && (
          <Button
            type="button"
            onClick={onRestart}
            disabled={restarting}
            variant="muted"
            size="xs"
            className="rounded-full"
          >
            <RotateCw
              className={cn('h-2.5 w-2.5', restarting && 'animate-spin')}
            />
            {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        )}

        <Button
          type="button"
          onClick={onSwitchInstance}
          variant="muted"
          size="xs"
          className="rounded-full"
        >
          <ArrowLeftRight className="h-2.5 w-2.5" />
          Switch
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
