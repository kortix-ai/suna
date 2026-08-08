/**
 * A provider can continue to report `stopped` while start() is still changing
 * the VM state. Reconciliation must not convert that transitional observation
 * into a durable Kortix stop, because doing so closes the compute meter and
 * leaves a later provider-running VM recorded as stopped.
 */
export const RUNTIME_WAKE_GRACE_MS = 90_000;
const RUNTIME_WAKE_POLL_MS = 1_000;

export async function waitForRuntimeWakeRunning(
  getStatus: () => Promise<string>,
  opts: {
    graceMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const graceMs = Math.max(0, opts.graceMs ?? RUNTIME_WAKE_GRACE_MS);
  const pollMs = Math.max(1, opts.pollMs ?? RUNTIME_WAKE_POLL_MS);
  const attempts = Math.max(1, Math.ceil(graceMs / pollMs));
  const sleep = opts.sleep ?? Bun.sleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getStatus().catch(() => 'unknown');
    if (status === 'running') return true;
    if (status === 'removed') return false;
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return false;
}

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
