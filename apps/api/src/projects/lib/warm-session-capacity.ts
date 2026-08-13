import { resolveAccountSessionLimit } from '../../shared/account-limits';
import { countActiveProjectSessions } from './sessions';

/**
 * Why a warm session could not be created right now.
 *
 * Carried in the 409 `WARM_SESSION_UNAVAILABLE` body as `reason`, so the skip
 * is debuggable without a new status code or a new response schema.
 */
export type WarmSessionUnavailableReason = 'concurrent_session_headroom';

/**
 * A warm session that cannot be created. 409 `WARM_SESSION_UNAVAILABLE` — the
 * same code the unreadable-repo skip already uses, for the same reason:
 * warming is SPECULATIVE, the client ignores every warm failure and falls
 * through to the normal create path, and `WarmProjectSessionResultSchema`
 * requires a `session`, so a 200-with-null would be a public contract change.
 */
export class WarmProjectSessionUnavailableError extends Error {
  constructor(
    readonly reason: WarmSessionUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'WarmProjectSessionUnavailableError';
  }
}

/**
 * May warming CREATE a new warm session at this account's occupancy?
 *
 * PURE — the whole policy in one predicate.
 *
 * A warm session sits at `provisioning`, which is in `ACTIVE_SESSION_STATUSES`
 * (lib/session-status.ts:10), so `countActiveProjectSessions` counts it and it
 * consumes a concurrent-session slot exactly like a working session. That is
 * correct — a warm box is real, booted, billed compute and the cap exists to
 * bound exactly that — but it means speculative warming could take the LAST
 * slot and 429 the next genuine session start. On Starter
 * (`concurrentSessionLimit: 3`, billing/services/tiers.ts:263) three project
 * page views with zero real work were enough.
 *
 * So warming keeps one slot free: it may create only while a free slot would
 * REMAIN afterwards. `limit - 1` rather than `limit`. A limit of 1 therefore
 * never warms, which is right — that account's only slot belongs to real work.
 *
 * This governs CREATE only. Returning an existing `available` warm session
 * costs nothing extra (that row is already counted), so reuse is never gated.
 */
export function warmSessionCreateFitsCap(activeSessions: number, limit: number): boolean {
  return activeSessions < limit - 1;
}

export interface WarmSessionCapacityDependencies {
  resolveLimit: typeof resolveAccountSessionLimit;
  countActive: typeof countActiveProjectSessions;
}

const defaultDependencies: WarmSessionCapacityDependencies = {
  resolveLimit: resolveAccountSessionLimit,
  countActive: countActiveProjectSessions,
};

/**
 * Throw `WarmProjectSessionUnavailableError` when creating a warm session would
 * leave the account with no free concurrent-session slot.
 *
 * Call this on the CREATE path only. Reuses the same limit resolution and the
 * same active-session count the real cap (`enforceConcurrentSessionCap`) uses,
 * so the two can never disagree about an account.
 */
export async function assertWarmSessionCapacity(
  accountId: string,
  dependencies: WarmSessionCapacityDependencies = defaultDependencies,
): Promise<void> {
  const [{ limit }, activeSessions] = await Promise.all([
    dependencies.resolveLimit(accountId),
    dependencies.countActive(accountId),
  ]);
  if (warmSessionCreateFitsCap(activeSessions, limit)) return;
  throw new WarmProjectSessionUnavailableError(
    'concurrent_session_headroom',
    'A warm session would consume the last concurrent-session slot.',
  );
}
