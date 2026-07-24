export type RuntimeReadinessMetadata = Record<string, unknown>;

export const RUNTIME_READINESS_CLOCK_KEYS = [
  'runtimeWakeStartedAt',
  'runtimeWakeProviderStatus',
  'runtimeWakeError',
  'runtimeWakeFailedAt',
  'opencodeReadyWaitStartedAt',
  'opencodeReadyWaitReason',
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
  return {
    ...next,
    lastTurnAt: now.toISOString(),
    runtimeWakeStartedAt: now.toISOString(),
    runtimeWakeProviderStatus: 'starting',
  };
}

export function staleOpencodeReadyReason(
  metadata: RuntimeReadinessMetadata,
  reason: string,
  nowMs = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
): string | null {
  if (reason !== 'not_ready' && reason !== 'unreachable') return null;
  const readyWaitStartedAtMs = parseTimestampMs(metadata.opencodeReadyWaitStartedAt);
  if (!readyWaitStartedAtMs || nowMs - readyWaitStartedAtMs <= staleAfterMs) return null;
  return reason === 'not_ready' ? 'runtime_not_ready_timeout' : 'runtime_unreachable_timeout';
}

export function hasRuntimeReadinessClock(metadata: RuntimeReadinessMetadata): boolean {
  return RUNTIME_READINESS_CLOCK_KEYS.some((key) => key in metadata);
}
