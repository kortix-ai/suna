/**
 * useSandboxPoller — monitors provisioning progress via HTTP polling.
 *
 * Adapted from the web frontend's useSandboxPoller hook.
 * Uses HTTP polling (GET /platform/sandbox/:id/status every 5s) instead of SSE
 * for simplicity and reliability on mobile.
 *
 * Includes time-based interpolation between stages for smooth progress animation.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { API_URL, getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import {
  STAGE_PROGRESS_MAP,
  STAGE_DURATION_MS,
  type ProvisioningStageInfo,
} from './provisioning-stages';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SandboxPollerState {
  status: 'idle' | 'polling' | 'ready' | 'error';
  progress: number;
  stages: ProvisioningStageInfo[] | null;
  currentStage: string | null;
  stageMessage: string | null;
  machineInfo: { ip: string; serverType: string; location: string } | null;
  error: string | null;
  stageEnteredAt: number | null;
}

interface StatusResponse {
  status: 'provisioning' | 'active' | 'error' | 'stopped' | 'archived' | 'not_found';
  stage: string | null;
  stageProgress: number | null;
  stageMessage: string | null;
  machineInfo: { ip: string; serverType: string; location: string } | null;
  stages: ProvisioningStageInfo[] | null;
  error?: string | null;
  startedAt: string | null;
}

interface UseSandboxPollerOpts {
  sandboxId?: string | null;
  externalId?: string | null;
  provider?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function initial(): SandboxPollerState {
  return {
    status: 'idle',
    progress: 0,
    stages: null,
    currentStage: null,
    stageMessage: null,
    machineInfo: null,
    error: null,
    stageEnteredAt: null,
  };
}

/** Interpolate progress within a stage based on elapsed time */
function interpolateProgress(stage: string, stageEnteredAt: number, baseProgress: number): number {
  const durationMs = STAGE_DURATION_MS[stage];
  if (!durationMs) return baseProgress;

  const nextStageKeys = Object.keys(STAGE_PROGRESS_MAP);
  const currentIdx = nextStageKeys.indexOf(stage);
  const nextStage = nextStageKeys[currentIdx + 1];
  const nextProgress = nextStage ? STAGE_PROGRESS_MAP[nextStage] : baseProgress + 5;

  const elapsed = Date.now() - stageEnteredAt;
  const fraction = Math.min(1, elapsed / durationMs);
  // ease-out: slow down as we approach the next stage
  const eased = 1 - Math.pow(1 - fraction, 2);
  const interpolated = Math.round(baseProgress + eased * (nextProgress - baseProgress - 1));
  // Never interpolate to 100 — that's reserved for truly ready
  return Math.min(interpolated, 99);
}

function getSandboxProxyUrl(sandboxId: string): string {
  const base = API_URL.replace('/v1', '');
  return `${base}/p/${sandboxId}/8000`;
}

async function waitForOpenCodeHealthy(
  sandboxId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const url = getSandboxProxyUrl(sandboxId);
  const timeout = 180_000; // 3 minutes
  const interval = 3_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    try {
      const token = await getAuthToken();
      const res = await fetch(`${url}/global/health`, {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.healthy === true) return true;
      }
    } catch {
      // Transient error — keep retrying
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useSandboxPoller(opts: UseSandboxPollerOpts = {}) {
  const {
    sandboxId = null,
    externalId = null,
    provider = null,
    enabled = true,
    timeoutMs = 660_000,
  } = opts;

  const isLocalDocker = provider === 'local_docker';

  const [state, setState] = useState<SandboxPollerState>(initial);
  const stateRef = useRef<SandboxPollerState>(state);
  const stoppedRef = useRef(false);
  const pollingRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interpolationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthAbortRef = useRef<AbortController | null>(null);

  const set = useCallback((next: SandboxPollerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const update = useCallback((patch: Partial<SandboxPollerState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  }, []);

  const cleanup = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    if (interpolationRef.current) {
      clearInterval(interpolationRef.current);
      interpolationRef.current = null;
    }
    if (healthAbortRef.current) {
      healthAbortRef.current.abort();
      healthAbortRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    pollingRef.current = false;
    cleanup();
  }, [cleanup]);

  const reset = useCallback(() => {
    stop();
    set(initial());
  }, [stop, set]);

  // ── Fetch sandbox status ───────────────────────────────────────────────

  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    if (!sandboxId) return null;
    try {
      const token = await getAuthToken();
      if (!token) return null;

      // Local Docker uses a different status endpoint
      if (isLocalDocker) {
        const res = await fetch(`${API_URL}/platform/init/local/status`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const d = data?.data ?? data;

        // Map local docker status to our StatusResponse shape
        if (d.status === 'ready' || d.status === 'running' || d.status === 'active') {
          return { status: 'active', stage: null, stageProgress: 100, stageMessage: 'Ready', machineInfo: null, stages: null, startedAt: null };
        }
        if (d.status === 'error') {
          return { status: 'error', stage: null, stageProgress: 0, stageMessage: d.message, machineInfo: null, stages: null, error: d.message || 'Provisioning failed', startedAt: null };
        }
        // If progress reached 100 but status hasn't flipped yet, treat as active
        if ((d.progress ?? 0) >= 100) {
          return { status: 'active', stage: null, stageProgress: 100, stageMessage: 'Ready', machineInfo: null, stages: null, startedAt: null };
        }
        // When progress is high (≥90), also check the DB sandbox status as fallback
        // The local init endpoint can lag behind the actual DB state
        const progress = d.progress ?? 0;
        if (progress >= 90) {
          try {
            const dbRes = await fetch(`${API_URL}/platform/sandbox/${sandboxId}/status`, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (dbRes.ok) {
              const dbData = await dbRes.json();
              const dbStatus = dbData?.data ?? dbData;
              if (dbStatus?.status === 'active') {
                return { status: 'active', stage: null, stageProgress: 100, stageMessage: 'Ready', machineInfo: null, stages: null, startedAt: null };
              }
            }
          } catch { /* fallback — continue with local status */ }
        }

        // Map to provisioning stages the UI understands
        const message = d.status === 'creating' ? 'Creating container...' : d.message || 'Pulling sandbox image...';
        let stage = 'cloud_init_running'; // generic provisioning stage
        if (progress < 10) stage = 'server_creating';
        else if (progress < 30) stage = 'server_created';
        else if (progress < 60) stage = 'cloud_init_running';
        else if (progress < 80) stage = 'cloud_init_done';
        else if (progress < 95) stage = 'services_starting';
        else stage = 'services_ready';

        return {
          status: 'provisioning',
          stage,
          stageProgress: progress,
          stageMessage: message,
          machineInfo: null,
          stages: null,
          startedAt: null,
        };
      }

      // Cloud (JustAVPS) — standard status endpoint
      const res = await fetch(`${API_URL}/platform/sandbox/${sandboxId}/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) return null;
      const data = await res.json();
      return data?.data ?? data;
    } catch {
      return null;
    }
  }, [sandboxId, isLocalDocker]);

  // ── Polling loop ────────────────────────────────────────────────────────

  const startPolling = useCallback(() => {
    if (stoppedRef.current || !sandboxId) return;

    pollingRef.current = true;
    update({ status: 'polling', stageEnteredAt: Date.now() });

    // Start interpolation interval (smooth progress between polls)
    // Skip for local docker — backend provides real progress every 2s
    if (!isLocalDocker && !interpolationRef.current) {
      interpolationRef.current = setInterval(() => {
        const s = stateRef.current;
        if (s.status !== 'polling' || !s.currentStage || s.stageEnteredAt === null) return;
        const base = STAGE_PROGRESS_MAP[s.currentStage] ?? s.progress;
        const interpolated = interpolateProgress(s.currentStage, s.stageEnteredAt, base);
        if (interpolated > s.progress) {
          const next = { ...s, progress: interpolated };
          stateRef.current = next;
          setState(next);
        }
      }, 500);
    }

    // Global timeout
    timeoutTimerRef.current = setTimeout(() => {
      if (!stoppedRef.current && pollingRef.current) {
        set({ ...stateRef.current, status: 'error', error: 'Provisioning timed out.' });
        stop();
      }
    }, timeoutMs);

    // Polling tick
    const tick = async () => {
      if (stoppedRef.current) return;

      try {
        const d = await fetchStatus();
        if (!d || stoppedRef.current) {
          // No data — keep polling
        } else if (d.status === 'active') {
          // Local docker: /init/local/status returning 'ready' is sufficient — skip health check
          if (isLocalDocker) {
            log.log('[SandboxPoller] Local sandbox ready!');
            set({ ...initial(), status: 'ready', progress: 100 });
            pollingRef.current = false;
            cleanup();
            return;
          }

          // Cloud: verify workspace health via proxy
          log.log('[SandboxPoller] Sandbox active, verifying health...');
          const healthId = externalId || sandboxId;
          if (!healthId) return;
          update({
            status: 'polling',
            currentStage: 'verifying_opencode',
            progress: STAGE_PROGRESS_MAP.verifying_opencode,
            stageEnteredAt: Date.now(),
          });

          healthAbortRef.current?.abort();
          const ac = new AbortController();
          healthAbortRef.current = ac;

          waitForOpenCodeHealthy(healthId, ac.signal).then((healthy) => {
            if (stoppedRef.current) return;
            if (healthy) {
              log.log('[SandboxPoller] Health check passed — ready!');
              set({ ...initial(), status: 'ready', progress: 100 });
            } else {
              log.error('[SandboxPoller] Health check failed');
              set({ ...stateRef.current, status: 'error', error: 'Workspace services failed to start.' });
            }
            pollingRef.current = false;
            cleanup();
          });
          return; // Don't schedule next poll — health check takes over
        } else if (d.status === 'error') {
          set({ ...initial(), status: 'error', error: d.error || 'Provisioning failed' });
          pollingRef.current = false;
          cleanup();
          return;
        } else {
          // Still provisioning — update state
          const isNewStage = d.stage !== null && d.stage !== stateRef.current.currentStage;
          // Local docker: use raw progress from backend (real pull %)
          // Cloud: use max of current and backend progress (interpolation fills gaps)
          const newProgress = isLocalDocker
            ? (d.stageProgress ?? stateRef.current.progress)
            : Math.max(stateRef.current.progress, d.stageProgress ?? stateRef.current.progress);
          update({
            progress: newProgress,
            stages: d.stages ?? stateRef.current.stages,
            currentStage: d.stage ?? stateRef.current.currentStage,
            stageMessage: d.stageMessage ?? stateRef.current.stageMessage,
            machineInfo: d.machineInfo ?? stateRef.current.machineInfo,
            stageEnteredAt: isNewStage ? Date.now() : stateRef.current.stageEnteredAt,
          });
        }
      } catch {
        // Transient error — keep polling
      }

      if (!stoppedRef.current) {
        pollTimerRef.current = setTimeout(tick, isLocalDocker ? 2_000 : 5_000);
      }
    };

    tick();
  }, [sandboxId, timeoutMs, cleanup, update, set, stop, fetchStatus]);

  // ── Start/stop based on enabled + sandboxId ────────────────────────────

  useEffect(() => {
    if (enabled && sandboxId && !pollingRef.current) {
      stoppedRef.current = false;
      startPolling();
    }

    return () => {
      stoppedRef.current = true;
      cleanup();
    };
  }, [enabled, sandboxId, startPolling, cleanup]);

  // ── Pause/resume on app background/foreground ──────────────────────────

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active' && enabled && sandboxId && !pollingRef.current && stateRef.current.status !== 'ready') {
        log.log('[SandboxPoller] App foregrounded, resuming polling');
        stoppedRef.current = false;
        startPolling();
      } else if (nextState === 'background') {
        log.log('[SandboxPoller] App backgrounded, pausing polling');
        stoppedRef.current = true;
        pollingRef.current = false;
        cleanup();
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [enabled, sandboxId, startPolling, cleanup]);

  return { ...state, stop, reset };
}
