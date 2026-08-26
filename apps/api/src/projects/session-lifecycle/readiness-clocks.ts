export type RuntimeReadinessMetadata = Record<string, unknown>;

export const RUNTIME_READINESS_CLOCK_KEYS = [
  'runtimeWakeStartedAt',
  'runtimeWakeProviderStatus',
  'runtimeWakeError',
  'runtimeWakeFailedAt',
  'opencodeReadyWaitStartedAt',
  'opencodeReadyWaitReason',
  'opencodeUnreachableWaitStartedAt',
  'opencodeNotReadyWaitStartedAt',
  'opencodeBootPhase',
  'opencodeBootWaitFirstSeenAt',
] as const;

/**
 * Absolute ceiling on one OpenCode boot wait, phase changes or not. The
 * per-reason budgets below restart on progress; this one never does, so a box
 * that keeps changing phase without ever becoming ready is still bounded.
 */
export const STALE_OPENCODE_BOOT_HARD_MS = 10 * 60 * 1000;

/**
 * Keys an explicit in-place restart clears on top of the readiness clocks: the
 * automatic retry accounting and the stop reason that would otherwise be
 * replayed as a verdict about the new attempt.
 */
const RUNTIME_RESTART_CLEARED_KEYS = [
  'runtimeStartFailureCount',
  'runtimeStartFailedAt',
  'runtimeStartRetryAfterAt',
  'runtimeWakeRetryAfterAt',
  'runtimeWakeProgressAt',
  'stopReason',
] as const;

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function prepareInPlaceRestartMetadata(
  metadata: RuntimeReadinessMetadata | null | undefined,
  now = new Date(),
): RuntimeReadinessMetadata {
  const next = { ...(metadata ?? {}) };
  for (const key of RUNTIME_READINESS_CLOCK_KEYS) delete next[key];
  // A human pressing Restart is an explicit "start this episode over": the
  // consecutive-failure accounting that escalates the automatic retry cooldown
  // (runtime-wake-fence.ts) resets with it, and no stale stop reason survives
  // to be replayed as a verdict about the new attempt.
  for (const key of RUNTIME_RESTART_CLEARED_KEYS) delete next[key];
  return {
    ...next,
    runtimeWakeStartedAt: now.toISOString(),
    runtimeWakeProviderStatus: 'starting',
  };
}

export function staleOpencodeReadyReason(
  metadata: RuntimeReadinessMetadata,
  reason: string,
  nowMs = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
  hardCapMs = STALE_OPENCODE_BOOT_HARD_MS,
): string | null {
  if (reason !== 'not_ready' && reason !== 'unreachable') return null;
  const firstSeenMs = parseTimestampMs(metadata.opencodeBootWaitFirstSeenAt);
  if (firstSeenMs && nowMs - firstSeenMs > hardCapMs) {
    return reason === 'not_ready' ? 'runtime_not_ready_timeout' : 'runtime_unreachable_timeout';
  }
  const reasonStartedAt =
    reason === 'unreachable'
      ? metadata.opencodeUnreachableWaitStartedAt
      : metadata.opencodeNotReadyWaitStartedAt;
  const legacyStartedAt =
    metadata.opencodeReadyWaitReason === undefined || metadata.opencodeReadyWaitReason === reason
      ? metadata.opencodeReadyWaitStartedAt
      : null;
  const readyWaitStartedAtMs = parseTimestampMs(reasonStartedAt) ?? parseTimestampMs(legacyStartedAt);
  if (!readyWaitStartedAtMs || nowMs - readyWaitStartedAtMs <= staleAfterMs) return null;
  return reason === 'not_ready' ? 'runtime_not_ready_timeout' : 'runtime_unreachable_timeout';
}

export function hasRuntimeReadinessClock(metadata: RuntimeReadinessMetadata): boolean {
  return RUNTIME_READINESS_CLOCK_KEYS.some((key) => key in metadata);
}

/**
 * The metadata patch that records one more not-ready observation, or null when
 * nothing changes.
 *
 * The per-reason clock (`opencodeNotReadyWaitStartedAt` /
 * `opencodeUnreachableWaitStartedAt`; legacy rows carry only
 * `opencodeReadyWaitStartedAt` + `opencodeReadyWaitReason`) is the one
 * `staleOpencodeReadyReason` budgets. It starts on the first observation of
 * that reason and — the point of this function — RESTARTS whenever the daemon
 * reports a different boot phase than last time: a box that is still making
 * progress has not stalled. `opencodeBootWaitFirstSeenAt` is written once per
 * boot wait and never moved; it feeds the hard cap.
 *
 * Essentia 2026-08-25 17:23–17:24: two resumes converged OpenCode 1.18.19 →
 * 1.18.23 and sat through that version's 53 s first init — legitimate work the
 * old fixed 90 s budget turned into `runtime_boot_failed` on both boxes.
 */
export function opencodeReadyWaitPatch(
  metadata: RuntimeReadinessMetadata,
  reason: 'not_ready' | 'unreachable',
  bootPhase: string | undefined,
  now = new Date(),
): RuntimeReadinessMetadata | null {
  const reasonClockKey =
    reason === 'unreachable' ? 'opencodeUnreachableWaitStartedAt' : 'opencodeNotReadyWaitStartedAt';
  const previousPhase =
    typeof metadata.opencodeBootPhase === 'string' ? metadata.opencodeBootPhase : undefined;
  const phaseChanged = bootPhase !== undefined && bootPhase !== previousPhase;
  const legacyClockRunning =
    metadata.opencodeReadyWaitReason === reason &&
    typeof metadata.opencodeReadyWaitStartedAt === 'string';
  const clockRunning = typeof metadata[reasonClockKey] === 'string' || legacyClockRunning;
  if (clockRunning && !phaseChanged) return null;
  const startedAt = now.toISOString();
  return {
    ...metadata,
    opencodeReadyWaitStartedAt: startedAt,
    opencodeReadyWaitReason: reason,
    [reasonClockKey]: startedAt,
    opencodeBootWaitFirstSeenAt:
      typeof metadata.opencodeBootWaitFirstSeenAt === 'string'
        ? metadata.opencodeBootWaitFirstSeenAt
        : startedAt,
    ...(bootPhase !== undefined ? { opencodeBootPhase: bootPhase } : {}),
  };
}
