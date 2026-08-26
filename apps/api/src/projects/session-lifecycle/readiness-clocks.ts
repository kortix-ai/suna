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
 * Absolute ceiling on ONE OpenCode boot wait, phase changes or not. The
 * per-reason budgets below restart on progress; this one never does, so a box
 * that keeps changing phase without ever becoming ready is still bounded.
 *
 * "ONE boot wait" is load-bearing and was not enforced. See
 * {@link runtimeBootEpochMs}.
 */
export const STALE_OPENCODE_BOOT_HARD_MS = 10 * 60 * 1000;

/**
 * Marks that identify the current boot attempt: when the wake was claimed, when
 * the provider confirmed the box RUNNING, and when the provisioner finished.
 * A readiness clock stamped BEFORE the newest of these belongs to an earlier
 * attempt on the same row.
 */
const RUNTIME_BOOT_EPOCH_KEYS = [
  'runtimeWakeStartedAt',
  'providerRunningConfirmedAt',
  'initSucceededAt',
] as const;

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

/**
 * When the CURRENT boot attempt began, or null when the row carries no mark.
 *
 * A readiness clock older than this was written by a previous attempt on the
 * same row and is not evidence about this one.
 *
 * *Incident (2026-08-26, Essentia, session 29861dfa / box inqwpv4a).* Attempt 1
 * failed during a post-roll build storm at ~13:27. The automatic cooldown rung
 * re-attempted at ~13:33: the resume launched the entrypoint, the daemon booted
 * through 13:34:48.8, authenticated to the gateway at 13:34:48.5–49.1 and
 * claimed its initial turn at 13:34:49.216 — but `/start` parked the box at
 * **13:34:49.202**. The boot lost by 14 ms to a budget it had not spent:
 * `opencodeBootWaitFirstSeenAt` was stamped during ATTEMPT 1 and nothing
 * cleared it, so the 10-minute hard cap was already ~7 minutes old when
 * attempt 2's boot started. Every automatic rung after the first was
 * deterministically doomed.
 *
 * Two fixes, and this is the second one — defence in depth. The first is that
 * a wake claim now clears every readiness clock (routes/shared.ts). This guard
 * makes an inherited clock harmless even if some future path forgets, and it
 * does so CAUSALLY: it does not reset the budget on progress (a stub launcher
 * respawning in a loop changes phase forever and must still be caught at the
 * cap — see the learning "A boot budget measures lack of progress, not
 * wall-clock"). It only refuses to charge this attempt for a previous one.
 */
export function runtimeBootEpochMs(metadata: RuntimeReadinessMetadata): number | null {
  let newest: number | null = null;
  for (const key of RUNTIME_BOOT_EPOCH_KEYS) {
    const parsed = parseTimestampMs(metadata[key]);
    if (parsed !== null && (newest === null || parsed > newest)) newest = parsed;
  }
  return newest;
}

/** A clock stamped before this boot attempt began is not evidence about it. */
function clockForThisBoot(clockMs: number | null, bootEpochMs: number | null): number | null {
  if (clockMs === null) return null;
  if (bootEpochMs !== null && clockMs < bootEpochMs) return null;
  return clockMs;
}

export function staleOpencodeReadyReason(
  metadata: RuntimeReadinessMetadata,
  reason: string,
  nowMs = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
  hardCapMs = STALE_OPENCODE_BOOT_HARD_MS,
): string | null {
  if (reason !== 'not_ready' && reason !== 'unreachable') return null;
  const bootEpochMs = runtimeBootEpochMs(metadata);
  const firstSeenMs = clockForThisBoot(
    parseTimestampMs(metadata.opencodeBootWaitFirstSeenAt),
    bootEpochMs,
  );
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
  const readyWaitStartedAtMs = clockForThisBoot(
    parseTimestampMs(reasonStartedAt) ?? parseTimestampMs(legacyStartedAt),
    bootEpochMs,
  );
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
  const bootEpochMs = runtimeBootEpochMs(metadata);
  // A clock stamped before this boot attempt began belongs to the previous one.
  // Treat it as absent so the patch re-baselines it, instead of leaving the row
  // carrying a budget it has already half spent (session 29861dfa).
  const firstSeenMs = parseTimestampMs(metadata.opencodeBootWaitFirstSeenAt);
  // INHERITED, not merely absent: the key exists and predates this attempt.
  const inheritedFirstSeen =
    firstSeenMs !== null && bootEpochMs !== null && firstSeenMs < bootEpochMs;
  const previousPhase =
    !inheritedFirstSeen && typeof metadata.opencodeBootPhase === 'string'
      ? metadata.opencodeBootPhase
      : undefined;
  const phaseChanged = bootPhase !== undefined && bootPhase !== previousPhase;
  const legacyClockRunning =
    metadata.opencodeReadyWaitReason === reason &&
    typeof metadata.opencodeReadyWaitStartedAt === 'string';
  const clockRunning =
    !inheritedFirstSeen && (typeof metadata[reasonClockKey] === 'string' || legacyClockRunning);
  if (clockRunning && !phaseChanged) return null;
  const startedAt = now.toISOString();
  return {
    ...metadata,
    opencodeReadyWaitStartedAt: startedAt,
    opencodeReadyWaitReason: reason,
    [reasonClockKey]: startedAt,
    opencodeBootWaitFirstSeenAt:
      !inheritedFirstSeen && typeof metadata.opencodeBootWaitFirstSeenAt === 'string'
        ? metadata.opencodeBootWaitFirstSeenAt
        : startedAt,
    ...(bootPhase !== undefined ? { opencodeBootPhase: bootPhase } : {}),
  };
}
