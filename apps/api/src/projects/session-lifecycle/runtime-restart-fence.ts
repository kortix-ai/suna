export const RUNTIME_RESTART_LEASE_MS = 4 * 60_000;

export interface RuntimeRestartClaim {
  id: string;
  startedAt: Date;
  leaseExpiresAt: Date;
}

export function runtimeRestartClaimMetadata(
  metadata: Record<string, unknown> | null | undefined,
  claim: RuntimeRestartClaim,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    runtimeRestartId: claim.id,
    runtimeRestartStartedAt: claim.startedAt.toISOString(),
    runtimeRestartLeaseExpiresAt: claim.leaseExpiresAt.toISOString(),
    runtimeRestartPhase: 'stopping',
  };
}

export function restartClaimIsActive(
  metadata: Record<string, unknown> | null | undefined,
  now = new Date(),
): boolean {
  if (typeof metadata?.runtimeRestartId !== 'string') return false;
  const expiresAt = Date.parse(
    String(metadata.runtimeRestartLeaseExpiresAt ?? ''),
  );
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}
