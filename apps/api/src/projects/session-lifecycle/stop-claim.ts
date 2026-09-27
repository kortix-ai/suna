import { sessionSandboxes } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';

import { sandboxStopClaimLeaseMs } from '../sandbox-deadline-policy';

/**
 * The stop claim on an `active` sandbox row: `metadata.lifecycleStopClaim`.
 *
 * A writer that is about to call `provider.stop()` claims the row first, in its
 * own short UPDATE, and then calls the provider with no transaction open. While
 * the claim is live:
 *   - `beginSandboxTurn` refuses a new prompt before it sends a byte;
 *   - a second stop, and an in-place restart, refuse to claim the row.
 * The stopped-state write (`applyStoppedState`, the park transition) strips the
 * claim. A writer whose stop failed releases it by its own token. A claim whose
 * writer died lapses after `sandboxStopClaimLeaseMs()`.
 */
export const STOP_CLAIM_KEY = 'lifecycleStopClaim';

export function stopClaimMetadata(token: string, now: Date): Record<string, unknown> {
  return { [STOP_CLAIM_KEY]: { token, claimedAtMs: now.getTime() } };
}

/** No stop claim on the row, or only one that has lapsed. */
export function noLiveStopClaim(now: Date): SQL {
  return sql`(
    ${sessionSandboxes.metadata}->'lifecycleStopClaim' IS NULL
    OR ${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'claimedAtMs' !~ '^[0-9]+$'
    OR (${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'claimedAtMs')::bigint
      <= ${now.getTime() - sandboxStopClaimLeaseMs()})`;
}

/** The row still carries THIS writer's stop claim. */
export function holdsStopClaim(token: string): SQL {
  return sql`${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'token' = ${token}`;
}
