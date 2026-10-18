/**
 * Per-account entitlement overrides, with expiry: the one escape hatch from
 * "the plan decides" (see .agents/skills/billing/references/plans-and-access.md).
 *
 * `credit_accounts.entitlement_overrides` is one JSONB column. Each entry is a
 * per-feature boolean with an optional `expires_at`:
 *
 *   { "sso": { "value": true, "expires_at": "2026-09-01T00:00:00.000Z" } }
 *
 * Overrides apply AFTER the plan, so `sso: {value:false}` switches one
 * capability off on an Enterprise account and `sso: {value:true}` switches it
 * on for a Credits account.
 *
 * PURE. Parsing only — no I/O, no clock of its own (`nowMs` is a parameter),
 * no imports that reach `../../config`.
 *
 * DEFENSIVE BY CONSTRUCTION. The column is JSONB written by admin routes and
 * data migrations, so the parser treats every shape as suspect: an unknown
 * key, a wrong-typed value, a malformed `expires_at` — each yields `undefined`
 * for that key and NEVER throws.
 */

import { isPlainObject } from '../../shared/json';

/** One override: the value, plus an optional ISO-8601 expiry. */
export interface OverrideEntry<T> {
  value: T;
  /** ISO-8601. Absent = never expires. At or past this instant the entry is ignored. */
  expires_at?: string;
}

/** Every override an account can carry: one boolean per feature. */
export interface EntitlementOverrides {
  sso?: OverrideEntry<boolean>;
  scim?: OverrideEntry<boolean>;
  rbac?: OverrideEntry<boolean>;
  auditAccess?: OverrideEntry<boolean>;
  branding?: OverrideEntry<boolean>;
  managedModels?: OverrideEntry<boolean>;
  /** The BYOK platform fee (byok-fee.ts): off waives it for the account. */
  byokFee?: OverrideEntry<boolean>;
}

export type OverrideKey = keyof EntitlementOverrides;

/** The value type of one key. */
export type OverrideValue<K extends OverrideKey> = NonNullable<EntitlementOverrides[K]>['value'];

/** The per-feature booleans, applied after the plan. */
export const ENTITLEMENT_OVERRIDE_KEYS = [
  'sso',
  'scim',
  'rbac',
  'auditAccess',
  'branding',
  'managedModels',
  'byokFee',
] as const;

/** Every key the parser accepts. Anything else is dropped. */
export const OVERRIDE_KEYS = [...ENTITLEMENT_OVERRIDE_KEYS] as const satisfies readonly OverrideKey[];

const KNOWN_KEYS: ReadonlySet<string> = new Set(OVERRIDE_KEYS);

/**
 * Milliseconds for an `expires_at`, or `null` when it is absent or unusable.
 * `undefined` (never expires) and "garbage" must not collapse into the same
 * answer, so the caller distinguishes them by checking `'expires_at' in entry`.
 */
function expiryMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The value of one override, or `undefined` when it is absent, malformed, or
 * expired at `nowMs`.
 *
 * `overrides` is `unknown` on purpose: callers hand it a raw JSONB column.
 */
export function readOverride<K extends OverrideKey>(
  overrides: unknown,
  key: K,
  nowMs: number = Date.now(),
): OverrideValue<K> | undefined {
  if (!isPlainObject(overrides)) return undefined;
  const entry = overrides[key];
  if (!isPlainObject(entry)) return undefined;

  const { value } = entry;
  if (typeof value !== 'boolean') return undefined;

  if (entry.expires_at !== undefined && entry.expires_at !== null) {
    const expires = expiryMs(entry.expires_at);
    // An unparseable expiry fails CLOSED: the operator meant the grant to end,
    // and honoring it forever because a timestamp was mistyped is the worse
    // failure.
    if (expires === null || expires <= nowMs) return undefined;
  }

  return value as OverrideValue<K>;
}

/**
 * Every well-formed entry, expiry NOT applied. Use it to store, echo, or audit
 * the column; use `readOverride` to decide anything. Unknown keys and
 * malformed entries are dropped, so what comes back can always be written
 * straight back to the column.
 */
export function parseEntitlementOverrides(raw: unknown): EntitlementOverrides {
  if (!isPlainObject(raw)) return {};
  const parsed: Record<string, OverrideEntry<boolean>> = {};
  for (const key of OVERRIDE_KEYS) {
    // `Number.POSITIVE_INFINITY` as `nowMs` would expire everything; `0` keeps
    // every entry whose shape is valid, which is exactly "shape, not expiry".
    const value = readOverride(raw, key, 0);
    if (value === undefined) continue;
    const entry = (raw as Record<string, Record<string, unknown>>)[key] as Record<string, unknown>;
    const expires = typeof entry.expires_at === 'string' ? entry.expires_at : undefined;
    parsed[key] = expires === undefined ? { value } : { value, expires_at: expires };
  }
  return parsed as EntitlementOverrides;
}

/**
 * The COLUMN shape — an index signature, because that is what a JSONB column
 * is. `EntitlementOverrides` is the same data with named optional keys, which
 * is what code should read; this is what gets written.
 */
export type StoredEntitlementOverrides = Record<string, OverrideEntry<boolean>>;

/** Narrow the named-key view to the column view, dropping absent keys. */
export function toStoredOverrides(overrides: EntitlementOverrides): StoredEntitlementOverrides {
  const stored: StoredEntitlementOverrides = {};
  for (const key of OVERRIDE_KEYS) {
    const entry = overrides[key];
    if (entry) stored[key] = entry;
  }
  return stored;
}

/**
 * A merge patch: an entry to set, or `null` to delete the key.
 * JSON Merge Patch semantics (RFC 7386), scoped to the known keys.
 */
export type EntitlementOverridePatch = {
  [K in OverrideKey]?: OverrideEntry<OverrideValue<K>> | null;
};

/** Apply a merge patch to the stored column. Pure; neither input is mutated. */
export function mergeOverridePatch(
  current: unknown,
  patch: EntitlementOverridePatch,
): EntitlementOverrides {
  const next: Record<string, unknown> = { ...parseEntitlementOverrides(current) };
  for (const [key, entry] of Object.entries(patch)) {
    if (entry === null || entry === undefined) delete next[key];
    else next[key] = entry;
  }
  return parseEntitlementOverrides(next);
}

/**
 * Validate one operator-supplied merge patch. Returns the patch, or the first
 * reason it is unacceptable.
 *
 * Stricter than `parseEntitlementOverrides`, and on purpose: the parser is
 * forgiving because it reads data that already exists, while this guards the
 * write. An unknown key or an out-of-range number is a typo the operator wants
 * to hear about, not something to silently drop.
 */
export function validateOverridePatch(
  raw: unknown,
): { ok: true; patch: EntitlementOverridePatch } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: 'body must be a JSON object of overrides' };

  const patch: Record<string, OverrideEntry<boolean> | null> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, error: `unknown override key "${key}" (known: ${OVERRIDE_KEYS.join(', ')})` };
    }
    if (entry === null) {
      patch[key] = null;
      continue;
    }
    if (!isPlainObject(entry)) {
      return { ok: false, error: `"${key}" must be null or an object { value, expires_at? }` };
    }

    const { value } = entry;
    if (typeof value !== 'boolean') {
      return { ok: false, error: `"${key}.value" must be a boolean` };
    }

    if (entry.expires_at !== undefined && entry.expires_at !== null) {
      if (expiryMs(entry.expires_at) === null) {
        return { ok: false, error: `"${key}.expires_at" must be an ISO-8601 timestamp` };
      }
      patch[key] = { value, expires_at: entry.expires_at as string };
      continue;
    }
    patch[key] = { value };
  }

  return { ok: true, patch: patch as EntitlementOverridePatch };
}
