/**
 * The Overrides card, as pure functions.
 *
 * `PUT /admin/api/accounts/{id}/overrides` is a merge patch (RFC 7386): a key
 * present with an entry sets it, a key present with `null` deletes it, and a key
 * that is ABSENT is left exactly as it was. So the card's job is a diff — send
 * the rows the operator changed and nothing else.
 *
 * Two consequences drive everything below:
 *
 *  1. **An unchanged row must not be sent.** The form has no expiry field, so
 *     every entry it writes is permanent. Re-sending an untouched
 *     `{value, expires_at}` would silently convert a timed grant into a forever
 *     one — an expiry that quietly stops expiring is the worst failure here.
 *  2. **The stored map is raw JSONB.** Admin routes, the trial primitive, data
 *     migrations and operator SQL all write it, so a wrong-typed value reads as
 *     "no override" (the same way `readOverride` treats it server-side) instead
 *     of rendering as a control that lies.
 *
 * Ranges mirror `validateOverridePatch`
 * (`apps/api/src/billing/services/entitlement-overrides.ts`) so a typo is a
 * disabled Save button and an inline message, not a 400 the operator has to
 * decode.
 */
import type {
  AdminEntitlementOverrideEntry,
  AdminEntitlementOverridePatch,
  AdminEntitlementOverrides,
} from '@/hooks/admin/use-admin-accounts';

/** Server ceiling for `maxConcurrentSessions` (MAX_CONCURRENT_SESSIONS_OVERRIDE). */
export const MAX_CONCURRENT_SESSIONS_OVERRIDE = 100_000;
/** Server ceiling for `computeRateMultiplier`. The floor is 0 — free compute. */
export const MAX_COMPUTE_RATE_MULTIPLIER = 10;

/**
 * A boolean override row. `inherit` is not a third value on the wire — it means
 * the key is absent, so the plan (and the enterprise expansion) decides.
 */
export type OverrideTriState = 'inherit' | 'on' | 'off';

/** The per-entitlement booleans, applied AFTER the enterprise expansion. */
export const BOOLEAN_OVERRIDE_KEYS = ['sso', 'scim', 'rbac', 'auditAccess', 'managedModels'] as const;
export type BooleanOverrideKey = (typeof BOOLEAN_OVERRIDE_KEYS)[number];

/** The two numeric overrides, edited as text so "" can mean inherit. */
export const NUMERIC_OVERRIDE_KEYS = ['maxConcurrentSessions', 'computeRateMultiplier'] as const;
export type NumericOverrideKey = (typeof NUMERIC_OVERRIDE_KEYS)[number];

/** Form state. Numbers are strings: `''` = inherit, and `'0'` is a real value. */
export type OverridesDraft = Record<BooleanOverrideKey, OverrideTriState> &
  Record<NumericOverrideKey, string>;

function entryOf(
  stored: AdminEntitlementOverrides | null | undefined,
  key: string,
): AdminEntitlementOverrideEntry | null {
  if (!stored || typeof stored !== 'object') return null;
  const entry = (stored as Record<string, unknown>)[key];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return entry as AdminEntitlementOverrideEntry;
}

/** The stored boolean, or null when the key is absent or wrong-typed. */
function booleanValue(
  stored: AdminEntitlementOverrides | null | undefined,
  key: BooleanOverrideKey,
): boolean | null {
  const value = entryOf(stored, key)?.value;
  return typeof value === 'boolean' ? value : null;
}

/** The stored number, or null when the key is absent or wrong-typed. */
function numericValue(
  stored: AdminEntitlementOverrides | null | undefined,
  key: NumericOverrideKey,
): number | null {
  const value = entryOf(stored, key)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The row's ISO expiry, or null when it never expires (or the timestamp is
 * unparseable — the server ignores such an entry, so the chip must not claim a
 * date the gate does not honor).
 */
export function overrideExpiresAt(
  stored: AdminEntitlementOverrides | null | undefined,
  key: string,
): string | null {
  const raw = entryOf(stored, key)?.expires_at;
  if (typeof raw !== 'string') return null;
  return Number.isFinite(new Date(raw).getTime()) ? raw : null;
}

/** True once the grant has lapsed: still on the row, no longer enforced. */
export function isOverrideExpired(expiresAt: string | null, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime();
  return Number.isFinite(ms) && ms <= nowMs;
}

/** Form state for an account, expiry NOT applied — a lapsed grant still shows. */
export function draftFromOverrides(
  stored: AdminEntitlementOverrides | null | undefined,
): OverridesDraft {
  const draft = {} as OverridesDraft;
  for (const key of BOOLEAN_OVERRIDE_KEYS) {
    const value = booleanValue(stored, key);
    draft[key] = value === null ? 'inherit' : value ? 'on' : 'off';
  }
  for (const key of NUMERIC_OVERRIDE_KEYS) {
    const value = numericValue(stored, key);
    draft[key] = value === null ? '' : String(value);
  }
  return draft;
}

export type OverridesPatchResult =
  | { ok: true; patch: AdminEntitlementOverridePatch }
  | { ok: false; error: string };

const NUMERIC_LABEL: Record<NumericOverrideKey, string> = {
  maxConcurrentSessions: 'Max concurrent sessions',
  computeRateMultiplier: 'Compute rate multiplier',
};

/**
 * The merge patch for one save: every row whose draft differs from what the
 * account carries, and nothing else.
 *
 * The comparison is against `draftFromOverrides(stored)` rather than the raw
 * map on purpose — a malformed stored entry reads as `inherit` on BOTH sides,
 * so opening the card on a corrupt row does not arm a delete the operator never
 * asked for.
 */
export function overridesPatch(
  draft: OverridesDraft,
  stored: AdminEntitlementOverrides | null | undefined,
): OverridesPatchResult {
  const base = draftFromOverrides(stored);
  const patch: AdminEntitlementOverridePatch = {};

  for (const key of BOOLEAN_OVERRIDE_KEYS) {
    const next = draft[key];
    if (next === base[key]) continue;
    patch[key] = next === 'inherit' ? null : { value: next === 'on' };
  }

  for (const key of NUMERIC_OVERRIDE_KEYS) {
    const next = draft[key].trim();
    const current = base[key];
    if (next === '') {
      // Empty means inherit. Only send the delete when something is there.
      if (current !== '') patch[key] = null;
      continue;
    }

    const value = Number(next);
    if (!Number.isFinite(value)) {
      return { ok: false, error: `${NUMERIC_LABEL[key]} must be a number, or blank to inherit.` };
    }
    if (key === 'maxConcurrentSessions') {
      if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_SESSIONS_OVERRIDE) {
        return {
          ok: false,
          error: `${NUMERIC_LABEL[key]} must be a whole number from 1 to ${MAX_CONCURRENT_SESSIONS_OVERRIDE}.`,
        };
      }
    } else if (value < 0 || value > MAX_COMPUTE_RATE_MULTIPLIER) {
      return {
        ok: false,
        error: `${NUMERIC_LABEL[key]} must be from 0 to ${MAX_COMPUTE_RATE_MULTIPLIER} (0 = free compute).`,
      };
    }

    // `'0.50'` and `0.5` are the same override: comparing numerically keeps a
    // cosmetic re-type from rewriting the entry (and dropping its expiry).
    if (current !== '' && Number(current) === value) continue;
    patch[key] = { value };
  }

  return { ok: true, patch };
}

/** Nothing to save — the Save button's disabled state, in one place. */
export function isEmptyPatch(patch: AdminEntitlementOverridePatch): boolean {
  return Object.keys(patch).length === 0;
}

/**
 * What the save actually did, for the success toast. An operator who changed
 * three rows needs the confirmation to say three, not "saved".
 */
export function describeOverridePatch(patch: AdminEntitlementOverridePatch): string {
  const keys = Object.keys(patch) as (keyof AdminEntitlementOverridePatch)[];
  const cleared = keys.filter((key) => patch[key] === null).length;
  const set = keys.length - cleared;
  const plural = (count: number) => (count === 1 ? 'override' : 'overrides');

  const parts: string[] = [];
  if (set > 0) parts.push(`${set} ${plural(set)} set`);
  if (cleared > 0) parts.push(`${cleared} ${plural(cleared)} cleared`);
  return parts.length === 0 ? 'No change.' : `${parts.join(', ')}.`;
}
