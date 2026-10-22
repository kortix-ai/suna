/**
 * What a failed auto top-up charge leaves on the account, read for people
 * (KRTX-1718). The billing pane showed only "off" after a declined card turned
 * auto top-up off; the reason sat in `auto_topup_disabled_reason`, read by no
 * API.
 *
 * Pure, so the rule is unit-tested without the charge path.
 */

/** After this many consecutive failures, auto top-up turns itself off. */
export const AUTO_TOPUP_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Stripe decline codes that warrant immediate auto-disable (no point retrying).
 * Anything else is treated as transient (backoff but keep enabled until the
 * consecutive-failures cap is reached).
 */
export const HARD_DECLINE_CODES = new Set([
  'card_declined',
  'insufficient_funds',
  'do_not_honor',
  'expired_card',
  'incorrect_cvc',
  'stolen_card',
  'lost_card',
  'pickup_card',
  'fraudulent',
  'authentication_required',
]);

/** Whether a failure with this reason, as the `failures`-th in a row, turns auto top-up off. */
export function failureDisablesAutoTopup(reason: string, failures: number): boolean {
  return HARD_DECLINE_CODES.has(reason) || failures >= AUTO_TOPUP_MAX_CONSECUTIVE_FAILURES;
}

export interface AutoTopupFailureRow {
  autoTopupEnabled: boolean | null;
  /** The last failed charge's reason. A success or a re-enable clears it. */
  autoTopupDisabledReason: string | null;
  autoTopupConsecutiveFailures: number | null;
  /** Stamped on every attempt; the failure time while a reason is stored. */
  autoTopupLastCharged: string | Date | null;
}

export interface AutoTopupFailure {
  /** The reason of the failure that turned auto top-up off; null while it is on or was turned off by hand. */
  disabled_reason: string | null;
  /** The decline code or failure text of the last failed charge; null after a success or a re-enable. */
  last_failure_reason: string | null;
  /** When that charge failed (ISO 8601). */
  last_failure_at: string | null;
}

export function autoTopupFailure(row: AutoTopupFailureRow): AutoTopupFailure {
  const reason = row.autoTopupDisabledReason || null;
  if (!reason) return { disabled_reason: null, last_failure_reason: null, last_failure_at: null };
  const at = row.autoTopupLastCharged ? new Date(row.autoTopupLastCharged).toISOString() : null;
  const offByFailure =
    !row.autoTopupEnabled && failureDisablesAutoTopup(reason, Number(row.autoTopupConsecutiveFailures) || 0);
  return { disabled_reason: offByFailure ? reason : null, last_failure_reason: reason, last_failure_at: at };
}
