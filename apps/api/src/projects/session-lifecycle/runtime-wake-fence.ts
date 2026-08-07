/**
 * A provider can continue to report `stopped` while start() is still changing
 * the VM state. Reconciliation must not convert that transitional observation
 * into a durable Kortix stop, because doing so closes the compute meter and
 * leaves a later provider-running VM recorded as stopped.
 */
export const RUNTIME_WAKE_GRACE_MS = 90_000;

export function runtimeWakeInProgress(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!metadata || typeof metadata.runtimeWakeId !== 'string') return false;
  if (typeof metadata.runtimeWakeStartedAt !== 'string') return false;
  const startedAtMs = Date.parse(metadata.runtimeWakeStartedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = now.getTime() - startedAtMs;
  return ageMs >= 0 && ageMs <= RUNTIME_WAKE_GRACE_MS;
}
