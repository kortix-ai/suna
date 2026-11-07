import type { UiTranslator } from '../../i18n';
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

import type { PatPolicy } from '@kortix/sdk';

/** `never`, or a whole number of days as a string. */
export type ExpiryOptionValue = string;

export interface ExpiryOption {
  value: ExpiryOptionValue;
  label: string;
}

export const NEVER_EXPIRES = 'never';

/** The shelf we offer from, shortest first. */
const OFFERED_DAYS = [1, 30, 90, 365] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayLabel(days: number): string {
  if (days === 1) return '1 day';
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
export function expiryOptions(
  policy: PatPolicy | null | undefined,
  tI18nComplete: UiTranslator,
): ExpiryOption[] {
  const cap = policy?.max_lifetime_days ?? null;
  const withinCap = cap == null ? [...OFFERED_DAYS] : OFFERED_DAYS.filter((d) => d <= cap);
  const days = cap != null && cap < 30 && cap !== 1
    ? [...withinCap, cap]
    : withinCap;

  const options: ExpiryOption[] = days.map((d) => ({ value: String(d), label: dayLabel(d) }));
  if (!policy?.require_expiry)
    options.unshift({ value: NEVER_EXPIRES, label: tI18nComplete.raw('text6300ef800bb8') });
  return options;
}

/**
 * The pre-selected option. "Never" when the workspace allows it — that is the
 * behaviour every key created before this control existed had, so an admin who
 * never set a rule sees no change. Otherwise 90 days, or the longest the cap
 * allows.
 */
export function defaultExpiryOption(
  policy: PatPolicy | null | undefined,
  tI18nComplete: UiTranslator,
): ExpiryOptionValue {
  const options = expiryOptions(policy, tI18nComplete);
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

/**
 * The longest expiry a new API key may have when the workspace policy sets no
 * maximum, and the expiry a key gets when the person picks none (design.md
 * §3.2 C4a, `resolveMintExpiry` in apps/api). The API reports both on the
 * policy (`effective_max_lifetime_days`, `default_lifetime_days`); these are
 * the values of an API that does not.
 */
const KEY_MAX_DAYS = 365;
const KEY_DEFAULT_DAYS = 90;

/**
 * What a person may pick for a new API key (a workspace key or a personal
 * key). Unlike a service account, a key always expires unless the workspace
 * policy allows no expiry (`allow_no_expiry`, and not `require_expiry`):
 *
 * - every preset up to the policy maximum (365 days when none is set);
 * - a maximum shorter than every preset becomes the only offer;
 * - "Never" only when the policy allows it.
 */
export function keyExpiryOptions(
  policy: PatPolicy | null | undefined,
  tI18nComplete: UiTranslator,
): ExpiryOption[] {
  const cap = policy?.effective_max_lifetime_days ?? policy?.max_lifetime_days ?? KEY_MAX_DAYS;
  const withinCap = OFFERED_DAYS.filter((d) => d <= cap);
  const days = cap < 30 && cap !== 1 ? [...withinCap, cap] : withinCap;
  const options: ExpiryOption[] = days.map((d) => ({ value: String(d), label: dayLabel(d) }));
  if (policy?.allow_no_expiry === true && policy.require_expiry !== true) {
    options.push({ value: NEVER_EXPIRES, label: tI18nComplete.raw('text6300ef800bb8') });
  }
  return options;
}

/** The pre-selected expiry of a new key: 90 days, or the longest the policy allows. */
export function defaultKeyExpiryOption(
  policy: PatPolicy | null | undefined,
  tI18nComplete: UiTranslator,
): ExpiryOptionValue {
  const options = keyExpiryOptions(policy, tI18nComplete);
  const preferred = options.find((o) => o.value === String(policy?.default_lifetime_days ?? KEY_DEFAULT_DAYS));
  if (preferred) return preferred.value;
  const dated = options.filter((o) => o.value !== NEVER_EXPIRES);
  return dated[dated.length - 1]?.value ?? options[0]?.value ?? String(KEY_DEFAULT_DAYS);
}

/**
 * The `expiresAt` a key mint sends: an ISO instant, or `null` for "Never".
 * `null` is explicit because the API gives a key without `expires_at` the
 * default lifetime (90 days), not "no expiry".
 */
export function keyExpiresAt(value: ExpiryOptionValue, now: number = Date.now()): string | null {
  if (value === NEVER_EXPIRES) return null;
  return expiresAtIso(value, now) ?? new Date(now + KEY_DEFAULT_DAYS * MS_PER_DAY).toISOString();
}
