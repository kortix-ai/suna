/**
 * Per-END-USER spend ceiling for Kortix-as-a-Backend.
 *
 * A wrapper account fronts many end-users, and `usage_events.origin_ref` already
 * attributes every backend session's spend to one of them — so a wrapper can
 * BILL each end-user. What it could not do is STOP one: the account-wide balance
 * check only fires once the whole wrapper is out of money, by which point a
 * single runaway end-user has already spent everyone else's budget.
 *
 * This is the money analogue of `enforcePerOriginSessionCap` (concurrency), and
 * it inherits that guard's honest limitations:
 *
 *   - It is CHECK-THEN-ACT. N parallel creates for one end-user can each observe
 *     the same under-limit total and all pass. It is a runaway-loop guardrail,
 *     not a hard quota.
 *   - It is measured at session CREATE. A session already running is not killed
 *     mid-turn when it crosses the line; the next create is what gets refused.
 *
 * Both are stated in the docs rather than papered over, because a wrapper that
 * believes this is a hard quota will build the wrong thing on top of it.
 */

/** The decision, kept pure so the policy is testable without a database. */
export type SpendCapDecision =
  | { allowed: true; reason: 'disabled' | 'no_end_user' | 'under_limit' }
  | { allowed: false; spentUsd: number; limitUsd: number; windowDays: number };

export interface SpendCapInput {
  /** The end-user this session is for, or null for a non-backend session. */
  endUserRef: string | null;
  /** Configured ceiling in USD. <= 0 means the cap is off. */
  limitUsd: number;
  /** Rolling window in days. */
  windowDays: number;
  /** Spend already attributed to this end-user inside the window. */
  spentUsd: number;
}

/**
 * `spentUsd >= limitUsd` refuses, so a limit of 0.5 with 0.5 already spent is
 * refused rather than allowed-then-exceeded. An end-user exactly at the ceiling
 * has, in every sense a wrapper cares about, reached it.
 */
export function decideSpendCap(input: SpendCapInput): SpendCapDecision {
  if (!(input.limitUsd > 0)) return { allowed: true, reason: 'disabled' };
  // Only backend sessions carry an end-user handle. A session without one has
  // nobody to charge, so there is nothing to cap — and silently applying the
  // account's total spend to it would refuse ordinary dashboard sessions.
  if (!input.endUserRef) return { allowed: true, reason: 'no_end_user' };
  if (input.spentUsd < input.limitUsd) return { allowed: true, reason: 'under_limit' };
  return {
    allowed: false,
    spentUsd: input.spentUsd,
    limitUsd: input.limitUsd,
    windowDays: input.windowDays,
  };
}

/**
 * The window's lower bound. Exported so the query and the error message can
 * never disagree about what "the last N days" meant.
 */
export function spendWindowStart(now: Date, windowDays: number): Date {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** The 429 body. Shaped like the concurrency cap's so a wrapper can handle both
 *  the same way, with a distinct `code` so it can tell them apart. */
export function spendCapError(decision: Extract<SpendCapDecision, { allowed: false }>) {
  const message =
    `This end-user has spent $${decision.spentUsd.toFixed(2)} in the last ${decision.windowDays} ` +
    `day${decision.windowDays === 1 ? '' : 's'} (limit $${decision.limitUsd.toFixed(2)}). ` +
    `Raise the limit or wait for the window to roll.`;
  return {
    status: 429 as const,
    headers: {
      'X-RateLimit-Limit': decision.limitUsd.toFixed(2),
      'X-RateLimit-Remaining': '0',
    },
    body: {
      error: message,
      message,
      code: 'per_end_user_spend_limit',
      limit_usd: decision.limitUsd,
      spent_usd: decision.spentUsd,
      window_days: decision.windowDays,
    },
  };
}
