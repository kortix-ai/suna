import type { SandboxProviderAdapter } from './providers';

export const PLATINUM_PROJECT_IMAGE_RESERVE_FRACTION = 0.1;
export const PLATINUM_PROJECT_IMAGE_MIN_RESERVE = 10;

type CapacityProvider = Pick<
  SandboxProviderAdapter,
  'id' | 'getSnapshotBuildCapacity'
>;

interface DaytonaAdmissionLike {
  allowed: boolean;
  reason: string;
}

interface AdmissionDeps {
  assessDaytona?: () => Promise<DaytonaAdmissionLike>;
}

export type FastProjectImageBuildAdmission =
  | {
      allowed: true;
      reason: 'allowed';
      used?: number;
      cap?: number;
      reserve?: number;
    }
  | {
      allowed: false;
      reason:
        | 'capacity_unavailable'
        | 'capacity_check_failed'
        | 'provider_reserve_reached'
        | `daytona_${string}`;
      used?: number;
      cap?: number;
      reserve?: number;
    };

export function platinumProjectImageReserve(cap: number): number {
  return Math.min(
    cap,
    Math.max(
      PLATINUM_PROJECT_IMAGE_MIN_RESERVE,
      Math.ceil(cap * PLATINUM_PROJECT_IMAGE_RESERVE_FRACTION),
    ),
  );
}

function validCapacity(value: { used: number; cap: number }): boolean {
  return (
    Number.isSafeInteger(value.used) &&
    Number.isSafeInteger(value.cap) &&
    value.used >= 0 &&
    value.cap >= 1 &&
    value.used <= value.cap
  );
}

async function defaultDaytonaAssessment(): Promise<DaytonaAdmissionLike> {
  const { assessDaytonaProjectImageAdmission } = await import('./quota-gc');
  return assessDaytonaProjectImageAdmission();
}

/**
 * Admit only optional FAST project-image writes. Existing image reads and
 * required provider-transition builds bypass this gate.
 */
export async function assessFastProjectImageBuildAdmission(
  provider: CapacityProvider,
  deps: AdmissionDeps = {},
): Promise<FastProjectImageBuildAdmission> {
  if (provider.id === 'platinum') {
    if (!provider.getSnapshotBuildCapacity) {
      return { allowed: false, reason: 'capacity_unavailable' };
    }
    try {
      const capacity = await provider.getSnapshotBuildCapacity();
      if (!validCapacity(capacity)) {
        return { allowed: false, reason: 'capacity_check_failed' };
      }
      const reserve = platinumProjectImageReserve(capacity.cap);
      const detail = { used: capacity.used, cap: capacity.cap, reserve };
      if (capacity.used >= capacity.cap - reserve) {
        return { allowed: false, reason: 'provider_reserve_reached', ...detail };
      }
      return { allowed: true, reason: 'allowed', ...detail };
    } catch {
      return { allowed: false, reason: 'capacity_check_failed' };
    }
  }

  if (provider.id === 'daytona') {
    try {
      const assessment = await (deps.assessDaytona ?? defaultDaytonaAssessment)();
      if (assessment.allowed) return { allowed: true, reason: 'allowed' };
      return { allowed: false, reason: `daytona_${assessment.reason}` };
    } catch {
      return { allowed: false, reason: 'capacity_check_failed' };
    }
  }

  // E2B supported project-image writes before FAST admission existed. E2B has
  // no shared snapshot-capacity endpoint to reserve against, so keep that
  // behavior unchanged. Unknown providers remain fail-closed below.
  if (provider.id === 'e2b') {
    return { allowed: true, reason: 'allowed' };
  }

  return { allowed: false, reason: 'capacity_unavailable' };
}
