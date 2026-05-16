/**
 * useSandboxPoller — monitors provisioning progress via SSE + HTTP polling fallback.
 *
 * Primary: connects to GET /platform/sandbox/:id/provision-stream (SSE)
 *   - Real-time stage updates from backend event bus
 *   - Works with both webhooks AND the background provision-poller
 *
 * Fallback: if SSE fails or disconnects, falls back to HTTP polling
 *   GET /platform/sandbox/:id/status every 5s
 *
 * The backend provision-poller (sandbox-provision-poller.ts) polls JustAVPS
 * every 8s and emits events, so even without webhooks the SSE stream gets updates.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { getSupabaseAccessToken } from '@/lib/auth-token';
import { backendApi } from '@/lib/api-client';
import { getEnv } from '@/lib/env-config';
import type { ProvisioningStageInfo } from '@/lib/provisioning-stages';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SandboxPollerState {
  status: 'idle' | 'polling' | 'ready' | 'error';
  progress: number;
  stages: ProvisioningStageInfo[] | null;
  currentStage: string | null;
  machineInfo: { ip: string; serverType: string; location: string } | null;
  error: string | null;
  stageEnteredAt: number | null; // timestamp when current stage was entered
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
  timeoutMs?: number;
}

// ─── Stage → progress mapping ───────────────────────────────────────────────

const STAGE_PROGRESS: Record<string, number> = {
  server_creating:       5,
  server_created:        15,
  cloud_init_running:    35,
  cloud_init_done:       60,
  services_starting:     80,
  services_ready:        95,
  verifying_opencode:    98,
  connecting:            99,
};

// Expected ms each stage lasts — used for time-based interpolation
const STAGE_DURATION_MS: Record<string, number> = {
  server_creating:    20_000,
  server_created:     30_000,
  cloud_init_running: 60_000,
  cloud_init_done:    30_000,
  services_starting:   20_000,
  services_ready:     180_000, // Services can take several minutes to start on cold boot
  verifying_opencode: 180_000,
  connecting:         15_000,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function initial(): SandboxPollerState {
  return { status: 'idle', progress: 0, stages: null, currentStage: null, machineInfo: null, error: null, stageEnteredAt: null };
}

/** Interpolate progress within a stage based on elapsed time */
function interpolateProgress(stage: string, stageEnteredAt: number, baseProgress: number): number {
  const durationMs = STAGE_DURATION_MS[stage];
  if (!durationMs) return baseProgress;
  const nextStageKeys = Object.keys(STAGE_PROGRESS);
  const currentIdx = nextStageKeys.indexOf(stage);
  const nextStage = nextStageKeys[currentIdx + 1];
  const nextProgress = nextStage ? STAGE_PROGRESS[nextStage] : baseProgress + 5;
  const elapsed = Date.now() - stageEnteredAt;
  const fraction = Math.min(1, elapsed / durationMs);
  // ease-out: slow down as we approach the next stage
  const eased = 1 - Math.pow(1 - fraction, 2);
  const interpolated = Math.round(baseProgress + eased * (nextProgress - baseProgress - 1));
  // Never interpolate to 100 — that's reserved for truly ready
  return Math.min(interpolated, 99);
}

function getPlatformUrl(): string {
  return getEnv().BACKEND_URL || 'http://localhost:8008/v1';
}

function getSandboxUrl(sandboxId: string): string {
  const base = getPlatformUrl().replace('/v1', '');
  return `${base}/p/${sandboxId}/8000`;
}

async function waitForOpenCodeHealthy(
  sandboxId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const url = getSandboxUrl(sandboxId);
  const timeout = 180_000; // 3 minutes — cold starts can take a while
  const interval = 3_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    let res: Response;
    try {
      res = await fetch(`${url}/global/health`, {
        signal,
        credentials: 'include',
      });
    } catch {
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      if (data?.healthy === true) return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useSandboxPoller(opts: UseSandboxPollerOpts = {}) {
  const {
    sandboxId = null,
    timeoutMs = 660_000,
  } = opts;

  const [state, setState] = useState<SandboxPollerState>(initial);
  const stateRef = useRef<SandboxPollerState>(state);
  const stoppedRef = useRef(false);
  const pollingRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
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

  // Start a 500ms interval that nudges progress forward within the active stage
  const startInterpolation = useCallback(() => {
    if (interpolationRef.current) return;
    interpolationRef.current = setInterval(() => {
      const s = stateRef.current;
      if (s.status !== 'polling' || !s.currentStage || s.stageEnteredAt === null) return;
      const base = STAGE_PROGRESS[s.currentStage] ?? s.progress;
      const interpolated = interpolateProgress(s.currentStage, s.stageEnteredAt, base);
      if (interpolated > s.progress) {
        const next = { ...s, progress: interpolated };
        stateRef.current = next;
        setState(next);
      }
    }, 500);
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

  // ── HTTP polling fallback ────────────────────────────────────────────────

  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    if (!sandboxId) return null;
    const res = await backendApi.get<StatusResponse>(`/platform/sandbox/${sandboxId}/status`, {
      showErrors: false,
      timeout: 10_000,
    });
    return res.success ? (res.data ?? null) : null;
  }, [sandboxId]);

  const startFallbackPolling = useCallback(() => {
    if (stoppedRef.current) return;

    const tick = async () => {
      if (stoppedRef.current) return;

      try {
        const d = await fetchStatus();
        if (!d || stoppedRef.current) {
          // No data — keep polling
        } else if (d.status === 'active') {
          update({
            status: 'polling',
            currentStage: 'verifying_opencode',
            progress: STAGE_PROGRESS.verifying_opencode,
            stageEnteredAt: Date.now(),
          });
          healthAbortRef.current?.abort();
          const ac = new AbortController();
          healthAbortRef.current = ac;
          if (!sandboxId) return;
          waitForOpenCodeHealthy(sandboxId, ac.signal).then((healthy) => {
            if (stoppedRef.current) return;
            if (healthy) {
              set({ ...initial(), status: 'ready', progress: 100 });
            } else {
              set({ ...stateRef.current, status: 'error', error: 'OpenCode services failed to start.' });
            }
            pollingRef.current = false;
            cleanup();
          });
          return;
        } else if (d.status === 'error') {
          set({ ...initial(), status: 'error', error: d.error || 'Provisioning failed' });
          pollingRef.current = false;
          return;
        } else {
          const isNewStage = d.stage !== null && d.stage !== stateRef.current.currentStage;
          update({
            progress: Math.max(stateRef.current.progress, d.stageProgress ?? stateRef.current.progress),
            stages: d.stages ?? stateRef.current.stages,
            currentStage: d.stage ?? stateRef.current.currentStage,
            machineInfo: d.machineInfo ?? stateRef.current.machineInfo,
            stageEnteredAt: isNewStage ? Date.now() : stateRef.current.stageEnteredAt,
          });
        }
      } catch {
        // Transient error — keep polling
      }

      if (!stoppedRef.current) {
        fallbackTimerRef.current = setTimeout(tick, 5_000);
      }
    };

    tick();
  }, [cleanup, fetchStatus, sandboxId, set, update]);

  // ── SSE-first provisioning monitor ───────────────────────────────────────

  const poll = useCallback(async (): Promise<SandboxPollerState> => {
    if (pollingRef.current) return stateRef.current;
    if (!sandboxId) return stateRef.current;

    pollingRef.current = true;
    stoppedRef.current = false;
    cleanup();
    update({ status: 'polling', stageEnteredAt: Date.now() });
    startInterpolation();

    // Global timeout
    timeoutTimerRef.current = setTimeout(() => {
      if (!stoppedRef.current && pollingRef.current) {
        set({ ...stateRef.current, status: 'error', error: 'Provisioning timed out.' });
        stop();
      }
    }, timeoutMs);

    // Try SSE first
    try {
      const token = await getSupabaseAccessToken();
      if (!token) throw new Error('No auth token');

      const baseUrl = getPlatformUrl();
      const sseUrl = `${baseUrl}/platform/sandbox/${sandboxId}/provision-stream?token=${encodeURIComponent(token)}`;

      const es = new EventSource(sseUrl);
      eventSourceRef.current = es;

      let sseConnected = false;

      es.addEventListener('status', (e) => {
        if (stoppedRef.current) return;
        sseConnected = true;
        try {
          const data = JSON.parse(e.data);
          if (data.status === 'active') {
            if (stateRef.current.currentStage === 'verifying_opencode') return;
            update({
              status: 'polling',
              currentStage: 'verifying_opencode',
              progress: STAGE_PROGRESS.verifying_opencode,
              stageEnteredAt: Date.now(),
            });
            healthAbortRef.current?.abort();
            const ac = new AbortController();
            healthAbortRef.current = ac;
            if (!sandboxId) return;
            waitForOpenCodeHealthy(sandboxId, ac.signal).then((healthy) => {
              if (stoppedRef.current) return;
              if (healthy) {
                set({ ...initial(), status: 'ready', progress: 100 });
              } else {
                set({ ...stateRef.current, status: 'error', error: 'OpenCode services failed to start.' });
              }
              pollingRef.current = false;
              cleanup();
            });
          } else if (data.status === 'error') {
            set({ ...initial(), status: 'error', error: data.message || 'Provisioning failed' });
            pollingRef.current = false;
            cleanup();
          } else if (data.provisioning_stage) {
            if (stateRef.current.currentStage === 'verifying_opencode') return;
            const progress = STAGE_PROGRESS[data.provisioning_stage] ?? stateRef.current.progress;
            const isNewStage = data.provisioning_stage !== stateRef.current.currentStage;
            update({
              progress: Math.max(stateRef.current.progress, progress),
              currentStage: data.provisioning_stage,
              stageEnteredAt: isNewStage ? Date.now() : stateRef.current.stageEnteredAt,
            });
          }
        } catch { /* malformed SSE data */ }
      });

      es.addEventListener('stage', (e) => {
        if (stoppedRef.current) return;
        try {
          const data = JSON.parse(e.data);

          if (data.status === 'ready' || data.stage === 'services_ready') {
            update({
              status: 'polling',
              currentStage: 'verifying_opencode',
              progress: STAGE_PROGRESS.verifying_opencode,
              stageEnteredAt: Date.now(),
            });
            healthAbortRef.current?.abort();
            const ac = new AbortController();
            healthAbortRef.current = ac;
            if (!sandboxId) return;
            waitForOpenCodeHealthy(sandboxId, ac.signal).then((healthy) => {
              if (stoppedRef.current) return;
              if (healthy) {
                set({ ...initial(), status: 'ready', progress: 100 });
              } else {
                set({ ...stateRef.current, status: 'error', error: 'OpenCode services failed to start.' });
              }
              pollingRef.current = false;
              cleanup();
            });
            return;
          }

          if (data.status === 'error') {
            set({ ...initial(), status: 'error', error: data.message || 'Provisioning failed' });
            pollingRef.current = false;
            cleanup();
            return;
          }

          if (data.stage) {
            // Once in verifying_opencode, don't accept stage changes until health passes
            if (stateRef.current.currentStage === 'verifying_opencode') return;
            const progress = STAGE_PROGRESS[data.stage] ?? stateRef.current.progress;
            const isNewStage = data.stage !== stateRef.current.currentStage;
            update({
              progress: Math.max(stateRef.current.progress, progress),
              currentStage: data.stage,
              stageEnteredAt: isNewStage ? Date.now() : stateRef.current.stageEnteredAt,
            });
          }
        } catch { /* malformed SSE data */ }
      });

      es.addEventListener('done', () => {
        // Stream completed — if we're still in polling state, check final status via HTTP
        if (pollingRef.current && !stoppedRef.current && stateRef.current.status === 'polling') {
          cleanup();
          startFallbackPolling();
        }
      });

      es.onerror = () => {
        if (stoppedRef.current) return;
        // SSE failed — fall back to HTTP polling
        console.warn('[useSandboxPoller] SSE connection failed, falling back to HTTP polling');
        cleanup();
        if (pollingRef.current) {
          startFallbackPolling();
        }
      };

      // If SSE doesn't connect within 5s, fall back
      setTimeout(() => {
        if (!sseConnected && pollingRef.current && !stoppedRef.current) {
          console.warn('[useSandboxPoller] SSE did not connect within 5s, falling back to HTTP polling');
          cleanup();
          startFallbackPolling();
        }
      }, 5_000);

    } catch {
      // SSE setup failed entirely — fall back to HTTP polling
      console.warn('[useSandboxPoller] SSE setup failed, using HTTP polling');
      startFallbackPolling();
    }

    return stateRef.current;
  }, [sandboxId, timeoutMs, cleanup, update, set, stop, startFallbackPolling, startInterpolation]);

  // Seed progress from a known stage on remount — prevents 0% flash while
  // waiting for the first SSE event when navigating back to a provisioning page.
  const seedStage = useCallback((stage: string) => {
    if (!stage) return;
    const progress = STAGE_PROGRESS[stage] ?? 0;
    if (progress > stateRef.current.progress) {
      update({ currentStage: stage, progress, stageEnteredAt: Date.now() });
    }
  }, [update]);

  // Emit the synthetic 'connecting' stage (machine ready, waiting for services)
  const setConnecting = useCallback(() => {
    const isNewStage = stateRef.current.currentStage !== 'connecting';
    update({
      currentStage: 'connecting',
      progress: Math.max(stateRef.current.progress, STAGE_PROGRESS.connecting),
      stageEnteredAt: isNewStage ? Date.now() : stateRef.current.stageEnteredAt,
    });
  }, [update]);

  // Cleanup on unmount
  useEffect(() => () => {
    stoppedRef.current = true;
    cleanup();
  }, [cleanup]);

  return { ...state, poll, stop, reset, seedStage, setConnecting };
}
