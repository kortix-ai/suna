'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { resolveServerUrl, useServerStore } from '@/stores/server-store';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useRouter } from 'next/navigation';
import {
  WifiOff,
  RefreshCw,
  ArrowLeftRight,
  Server,
  RotateCw,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { restartSandbox } from '@/lib/platform-client';

/**
 * ConnectingScreen — overlay shown when the active instance is not reachable.
 *
 * Three visual modes:
 *   1. **First connection** (never connected before) — full-screen blocking overlay
 *      with spinner + "Connecting to …". User can still switch instances.
 *   2. **Unreachable** (first connection failed after threshold) — full-screen blocking
 *      overlay with diagnostics, retry counter, and Docker-specific help.
 *   3. **Reconnecting** (was connected, then lost connection) — non-blocking floating
 *      pill at bottom-right so users can keep working.
 */
export function ConnectingScreen() {
  const status = useSandboxConnectionStore((s) => s.status);
  const wasConnected = useSandboxConnectionStore((s) => s.wasConnected);
  const reconnectAttempts = useSandboxConnectionStore((s) => s.reconnectAttempts);
  const disconnectedAt = useSandboxConnectionStore((s) => s.disconnectedAt);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === activeServerId);
  const router = useRouter();
  const [restarting, setRestarting] = useState(false);

  const isCloudProvider = activeServer?.provider && activeServer.provider !== 'local_docker';

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await restartSandbox();
      toast.success('Machine restart initiated. Reconnecting…', { duration: 5000 });
    } catch (err) {
      toast.error(
        `Restart failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        { duration: 5000 },
      );
    } finally {
      // Keep the restarting state for a bit — the health checker will pick up
      // recovery and flip status to 'connected', clearing the overlay.
      setTimeout(() => setRestarting(false), 15_000);
    }
  }, [restarting]);

  if (status === 'connected') return null;

  const serverLabel = activeServer?.label || 'Instance';
  const serverUrl = activeServer ? resolveServerUrl(activeServer).replace(/^https?:\/\//, '') : '';
  const handleSwitch = () => router.push('/instances');

  // ── Reconnecting (was connected before) → lightweight pill ──
  if (wasConnected) {
    return (
      <ReconnectPill
        disconnectedAt={disconnectedAt}
        onSwitchInstance={handleSwitch}
        onRestart={isCloudProvider ? handleRestart : undefined}
        restarting={restarting}
      />
    );
  }

  // ── First connection or unreachable → full-screen overlay ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background animate-in fade-in duration-200">
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-8 text-center">

        {status === 'connecting' && (
          <FirstConnectContent
            label={serverLabel}
            url={serverUrl}
            onRestart={isCloudProvider ? handleRestart : undefined}
            restarting={restarting}
          />
        )}
        {status === 'unreachable' && (
          <UnreachableContent
            label={serverLabel}
            url={serverUrl}
            reconnectAttempts={reconnectAttempts}
            provider={activeServer?.provider}
            onRestart={isCloudProvider ? handleRestart : undefined}
            restarting={restarting}
          />
        )}

        <div className="flex items-center gap-2">
          {status === 'unreachable' && isCloudProvider && (
            <button
              type="button"
              onClick={handleRestart}
              disabled={restarting}
              className="flex items-center gap-2 h-9 px-4 text-sm font-medium text-foreground/80 hover:text-foreground bg-muted/50 hover:bg-muted border border-border/40 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw className={`h-3.5 w-3.5 ${restarting ? 'animate-spin' : ''}`} />
              {restarting ? 'Restarting…' : 'Restart Machine'}
            </button>
          )}
          <button
            type="button"
            onClick={handleSwitch}
            className="flex items-center gap-2 h-9 px-4 text-sm font-medium text-foreground/80 hover:text-foreground bg-muted/50 hover:bg-muted border border-border/40 rounded-lg transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Switch Instance
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toast hook (mounted alongside the screen) ──────────────────────────────

export function useConnectionToasts() {
  const status = useSandboxConnectionStore((s) => s.status);
  const wasConnected = useSandboxConnectionStore((s) => s.wasConnected);
  const initialCheckDone = useSandboxConnectionStore((s) => s.initialCheckDone);

  const prevStatusRef = useRef<SandboxConnectionStatus | null>(null);

  useEffect(() => {
    if (!initialCheckDone) return;

    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === null) return;

    if (prev === 'connected' && (status === 'unreachable' || status === 'connecting') && wasConnected) {
      toast.error('Instance connection lost. Reconnecting…', { duration: 4000 });
    }

    if ((prev === 'unreachable' || prev === 'connecting') && status === 'connected' && wasConnected) {
      toast.success('Instance reconnected!', { duration: 3000 });
    }
  }, [status, wasConnected, initialCheckDone]);
}

type SandboxConnectionStatus = 'connecting' | 'connected' | 'unreachable';

// ============================================================================
// Full-screen sub-components
// ============================================================================

/** Connecting state — spinner + server label */
function FirstConnectContent({
  label,
  url,
  onRestart,
  restarting,
}: {
  label: string;
  url: string;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  return (
    <>
      {/* Icon ring */}
      <div className="relative">
        <div className="absolute -inset-3 rounded-full bg-primary/5 animate-pulse" />
        <div className="relative flex items-center justify-center w-16 h-16 rounded-full bg-muted/50 border border-border/40">
          <Server className="w-6 h-6 text-muted-foreground/70" />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          Connecting to {label}
        </h2>
        {url && (
          <p className="text-[13px] text-muted-foreground/60 font-mono truncate max-w-xs mx-auto">
            {url}
          </p>
        )}
      </div>

      <KortixLoader size="small" />

      {onRestart && (
        <Button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          variant="muted"
          size="sm"
          className="rounded-full"
        >
          <RotateCw className={`h-3.5 w-3.5 ${restarting ? 'animate-spin' : ''}`} />
          {restarting ? 'Restarting…' : 'Restart'}
        </Button>
      )}
    </>
  );
}

/** Unreachable state — diagnostics + retry counter */
function UnreachableContent({
  label,
  url,
  reconnectAttempts,
  provider,
  onRestart,
  restarting,
}: {
  label: string;
  url: string;
  reconnectAttempts: number;
  provider?: string;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const isLocalDocker = provider === 'local_docker';

  return (
    <>
      {/* Icon */}
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10 border border-destructive/20">
        <WifiOff className="w-6 h-6 text-destructive/60" />
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          {isLocalDocker ? 'Local Sandbox Unreachable' : 'Instance Unreachable'}
        </h2>
        {url && (
          <p className="text-[13px] text-muted-foreground/60 font-mono truncate max-w-xs mx-auto">
            {url}
          </p>
        )}
        <p className="text-sm text-muted-foreground/70 leading-relaxed max-w-sm mx-auto">
          {isLocalDocker ? (
            <>
              Unable to reach the local Docker sandbox.
              {' '}Make sure Docker is running and the container has started.
            </>
          ) : (
            <>
              Unable to reach <span className="font-medium text-foreground/80">{label}</span>.
              {' '}It may be starting up or temporarily unavailable.
            </>
          )}
        </p>
      </div>

      {/* Retry indicator */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground/50">
        <span className="flex items-center gap-1.5">
          {restarting ? (
            <RotateCw className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3 animate-spin" />
          )}
          {restarting ? 'Restarting machine…' : 'Retrying automatically'}
        </span>
        {reconnectAttempts > 0 && !restarting && (
          <span className="px-2 py-0.5 bg-muted/40 rounded-full text-[10px] font-mono tabular-nums">
            attempt {reconnectAttempts}
          </span>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Non-blocking reconnect pill
// ============================================================================

/** Floating pill at bottom-right when reconnecting after a previous connection */
function ReconnectPill({
  disconnectedAt,
  onSwitchInstance,
  onRestart,
  restarting,
}: {
  disconnectedAt: number | null;
  onSwitchInstance: () => void;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const elapsed = useElapsedTime(disconnectedAt);

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-3 fade-in duration-300">
      <div className="flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 bg-background/95 backdrop-blur-xl border border-border/50 rounded-full shadow-lg shadow-black/5">
        {/* Pulsing dot */}
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {restarting ? 'Restarting' : 'Reconnecting'}
          {elapsed && !restarting && <span className="text-muted-foreground/40"> · {elapsed}</span>}
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
            <RotateCw className={`h-2.5 w-2.5 ${restarting ? 'animate-spin' : ''}`} />
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

// ── Utility hook ──

/** Human-readable elapsed time string, updating every second */
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
