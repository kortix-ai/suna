/**
 * The expiry choice offered when creating a key, derived from the workspace's
 * own key rules.
 *
 * This exists because the two halves were previously disconnected: the tab let
 * an admin turn on "every key must have an expiry date"
 * (`PatPolicy.require_expiry`), and the create form offered no way to set one.
 * `createAccountToken` then rejected every attempt with a 400
 * (`repositories/account-tokens.ts`, `PatPolicyError('expiry_required')`), so
 * switching the rule on made key creation impossible from the UI that owns the
 * rule. Offering the dates the policy actually permits is the fix.
 *
 * Pure and separately tested — the rules are arithmetic on a policy record,
 * and `apps/web` can only test the parts with no React in them.
 */

import type { PatPolicy } from '@/lib/iam-client';

/** `never`, or a whole number of days as a string. */
export type ExpiryOptionValue = string;

export interface ExpiryOption {
  value: ExpiryOptionValue;
  label: string;
}

export const NEVER_EXPIRES = 'never';

/** The shelf we offer from, shortest first. */
const OFFERED_DAYS = [30, 90, 365] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayLabel(days: number): string {
  if (days === 365) return '1 year';
  if (days % 365 === 0) return `${days / 365} years`;
  return `${days} days`;
}

/**
 * What a person may pick, given the workspace rules.
 *
 * - `require_expiry` removes "Never" — the backend would refuse it anyway, and
 *   an option that always fails is worse than no option.
 * - `max_lifetime_days` drops any preset further out than the cap. If the cap
 *   is shorter than every preset (a 7-day cap, say) the cap itself becomes the
 *   only offer, so the form is never left with nothing to choose.
 * - `max_lifetime_days` does NOT imply an expiry is required: the backend only
 *   compares the cap against a requested `expires_at`, so a never-expiring key
 *   is still legal under a cap (`createAccountToken` checks `requireExpiry`
 *   and the cap independently).
 */
export function expiryOptions(policy?: PatPolicy | null): ExpiryOption[] {
  const cap = policy?.max_lifetime_days ?? null;
  const withinCap = cap == null ? [...OFFERED_DAYS] : OFFERED_DAYS.filter((d) => d <= cap);
  const days = withinCap.length > 0 ? withinCap : cap != null ? [cap] : [];

  const options: ExpiryOption[] = days.map((d) => ({ value: String(d), label: dayLabel(d) }));
  if (!policy?.require_expiry) options.unshift({ value: NEVER_EXPIRES, label: 'Never' });
  return options;
}

/**
 * The pre-selected option. "Never" when the workspace allows it — that is the
 * behaviour every key created before this control existed had, so an admin who
 * never set a rule sees no change. Otherwise 90 days, or the longest the cap
 * allows.
 */
export function defaultExpiryOption(policy?: PatPolicy | null): ExpiryOptionValue {
  const options = expiryOptions(policy);
  const never = options.find((o) => o.value === NEVER_EXPIRES);
  if (never) return never.value;
  const preferred = options.find((o) => o.value === '90');
  if (preferred) return preferred.value;
  return options[options.length - 1]?.value ?? NEVER_EXPIRES;
}

/**
 * The ISO instant to send, or `undefined` for a key that never expires (both
 * create endpoints treat a missing `expires_at` as "no expiry").
 *
 * `now` is injected rather than read from the clock so the mapping is
 * testable.
 */
export function expiresAtIso(
  value: ExpiryOptionValue,
  now: number = Date.now(),
): string | undefined {
  if (value === NEVER_EXPIRES) return undefined;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(now + days * MS_PER_DAY).toISOString();
}
