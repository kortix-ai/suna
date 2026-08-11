/**
 * Per-account entitlement overrides, with expiry.
 *
 * `credit_accounts` grew one column per override — `enterprise_entitled`,
 * `demo_enterprise`, `managed_models_override`, `max_concurrent_sessions` —
 * and each one cost a migration, a repository accessor, an admin route, and a
 * resolver branch. None of them can expire, so every temporary grant (a
 * proof-of-concept Enterprise, a comped session cap, a discounted compute rate)
 * had to be swept by hand or was simply left on forever.
 *
 * `credit_accounts.entitlement_overrides` is one JSONB column that holds all of
 * them, each entry carrying an optional `expires_at`:
 *
 *   { "sso": { "value": true, "expires_at": "2026-09-01T00:00:00.000Z" } }
 *
 * PURE. Parsing only — no I/O, no clock of its own (`nowMs` is a parameter),
 * no imports that reach `../../config`. The resolver
 * (`resolve-billing.ts`) applies these; the admin route writes them through
 * `applyAdminOverride`.
 *
 * DEFENSIVE BY CONSTRUCTION. The column is JSONB written by admin routes, data
 * migrations, and operator SQL, so the parser treats every shape as suspect: an
 * unknown key, a wrong-typed value, a malformed `expires_at`, a string where an
 * object belongs — each yields `undefined` for that key and NEVER throws. A
 * corrupt override must degrade to "no override", not 500 the entitlement
 * gate that reads it.
 */

/** One override: the value, plus an optional ISO-8601 expiry. */
export interface OverrideEntry<T> {
  value: T;
  /** ISO-8601. Absent = never expires. At or past this instant the entry is ignored. */
  expires_at?: string;
}

/**
 * Every override an account can carry.
 *
 * The first four mirror the legacy columns of the same name (which are still
 * written — see the migration). `computeRateMultiplier` is new: custom compute
 * pricing for one account. The last five are per-entitlement booleans that
 * apply AFTER the enterprise-flag expansion, so `sso: {value:false}` can switch
 * one capability off even for an enterprise-entitled account.
 */
export interface EntitlementOverrides {
  enterpriseEntitled?: OverrideEntry<boolean>;
  demoEnterprise?: OverrideEntry<boolean>;
  managedModelsOverride?: OverrideEntry<boolean>;
  maxConcurrentSessions?: OverrideEntry<number>;
  computeRateMultiplier?: OverrideEntry<number>;
  sso?: OverrideEntry<boolean>;
  scim?: OverrideEntry<boolean>;
  rbac?: OverrideEntry<boolean>;
  auditAccess?: OverrideEntry<boolean>;
  managedModels?: OverrideEntry<boolean>;
}

export type OverrideKey = keyof EntitlementOverrides;

/** The value type of one key, e.g. `boolean` for `sso`, `number` for `maxConcurrentSessions`. */
export type OverrideValue<K extends OverrideKey> = NonNullable<EntitlementOverrides[K]>['value'];

/** The five per-entitlement booleans, applied after the enterprise expansion. */
export const ENTITLEMENT_OVERRIDE_KEYS = [
  'sso',
  'scim',
  'rbac',
  'auditAccess',
  'managedModels',
] as const;

/** Keys whose value is a number. Everything else in the catalog is a boolean. */
export const NUMERIC_OVERRIDE_KEYS = ['maxConcurrentSessions', 'computeRateMultiplier'] as const;

/** Every key the parser accepts. Anything else is dropped. */
export const OVERRIDE_KEYS = [
  'enterpriseEntitled',
  'demoEnterprise',
  'managedModelsOverride',
  'maxConcurrentSessions',
  'computeRateMultiplier',
  ...ENTITLEMENT_OVERRIDE_KEYS,
] as const satisfies readonly OverrideKey[];

const NUMERIC_KEYS: ReadonlySet<string> = new Set(NUMERIC_OVERRIDE_KEYS);
const KNOWN_KEYS: ReadonlySet<string> = new Set(OVERRIDE_KEYS);

/**
 * Upper bound for a `maxConcurrentSessions` override. Deliberately the same
 * number as `MAX_ACCOUNT_SESSION_LIMIT` (admin/account-session-limit.ts), which
 * bounds the legacy column — the two spellings of one override must not accept
 * different ranges. Duplicated rather than imported because this module is a
 * pure billing primitive and must not depend on the admin surface;
 * `unit-entitlement-overrides.test.ts` fails if the two ever diverge.
 */
export const MAX_CONCURRENT_SESSIONS_OVERRIDE = 100_000;

/**
 * Upper bound for a compute rate multiplier. 10× list is already an extreme
 * contractual markup; anything above it is a fat finger, and an unbounded
 * multiplier here is a way to bill an account 1000× by typo.
 *
 * The LOWER bound is 0, and 0 is meaningful: free compute. Internal, demo, and
 * partner accounts get it deliberately, which is why the floor is not 1.
 */
export const MAX_COMPUTE_RATE_MULTIPLIER = 10;

/** No override anywhere: the multiplier every account bills at by default. */
export const DEFAULT_COMPUTE_RATE_MULTIPLIER = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  if (NUMERIC_KEYS.has(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  } else if (typeof value !== 'boolean') {
    return undefined;
  }

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
  const parsed: Record<string, OverrideEntry<boolean | number>> = {};
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
export type StoredEntitlementOverrides = Record<string, OverrideEntry<boolean | number>>;

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
 * Drop a fixed set of keys. Used by `grantTemporaryAccess`, which OWNS the keys
 * it derives from a plan record: re-granting must not leave an earlier grant's
 * key behind with the earlier grant's expiry.
 */
export function withoutOverrideKeys(
  current: unknown,
  keys: readonly OverrideKey[],
): EntitlementOverrides {
  const next: Record<string, unknown> = { ...parseEntitlementOverrides(current) };
  for (const key of keys) delete next[key];
  return next as EntitlementOverrides;
}

/**
 * Clamp a compute rate multiplier into `[0, MAX_COMPUTE_RATE_MULTIPLIER]`.
 * Anything absent or non-finite reads as the default (1) — a broken override
 * must bill at list price, never at zero and never at a random number.
 */
export function clampComputeRateMultiplier(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_COMPUTE_RATE_MULTIPLIER;
  }
  return Math.min(Math.max(value, 0), MAX_COMPUTE_RATE_MULTIPLIER);
}

/** The four legacy columns a patch can also have to write. */
export interface LegacyOverrideColumns {
  enterpriseEntitled?: boolean;
  demoEnterprise?: boolean;
  managedModelsOverride?: boolean | null;
  maxConcurrentSessions?: number | null;
}

/**
 * The legacy-column write that must accompany a patch, for the one release in
 * which both representations are live.
 *
 * WHY AN EXPIRING ENTRY CLEARS THE COLUMN INSTEAD OF MIRRORING ITS VALUE.
 * The resolver falls back to the legacy column when the JSONB key does not
 * apply — and an EXPIRED entry does not apply. Mirroring `{value:true,
 * expires_at:…}` onto `enterprise_entitled = true` would therefore hand the
 * account a permanent entitlement the moment its temporary one lapsed: the
 * expiry would silently do nothing. So an entry with an expiry (and a deletion)
 * writes the column's no-override value, leaving the JSONB as the only source
 * of that grant. The cost is that an API task from the previous release does
 * not see a TIMED grant — it fails closed, which is the correct direction.
 */
export function legacyMirrorPatch(patch: EntitlementOverridePatch): LegacyOverrideColumns {
  const columns: LegacyOverrideColumns = {};
  const permanent = <T>(entry: OverrideEntry<T> | null | undefined): T | undefined =>
    entry && entry.expires_at === undefined ? entry.value : undefined;

  if ('enterpriseEntitled' in patch) {
    columns.enterpriseEntitled = permanent(patch.enterpriseEntitled) ?? false;
  }
  if ('demoEnterprise' in patch) {
    columns.demoEnterprise = permanent(patch.demoEnterprise) ?? false;
  }
  if ('managedModelsOverride' in patch) {
    columns.managedModelsOverride = permanent(patch.managedModelsOverride) ?? null;
  }
  if ('maxConcurrentSessions' in patch) {
    columns.maxConcurrentSessions = permanent(patch.maxConcurrentSessions) ?? null;
  }
  return columns;
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

  const patch: Record<string, OverrideEntry<boolean | number> | null> = {};
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
    if (NUMERIC_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `"${key}.value" must be a finite number` };
      }
      if (key === 'maxConcurrentSessions') {
        if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_SESSIONS_OVERRIDE) {
          return {
            ok: false,
            error: `"maxConcurrentSessions.value" must be an integer from 1 to ${MAX_CONCURRENT_SESSIONS_OVERRIDE}`,
          };
        }
      }
      if (key === 'computeRateMultiplier') {
        if (value < 0 || value > MAX_COMPUTE_RATE_MULTIPLIER) {
          return {
            ok: false,
            error: `"computeRateMultiplier.value" must be from 0 to ${MAX_COMPUTE_RATE_MULTIPLIER} (0 = free compute)`,
          };
        }
      }
    } else if (typeof value !== 'boolean') {
      return { ok: false, error: `"${key}.value" must be a boolean` };
    }

    if (entry.expires_at !== undefined && entry.expires_at !== null) {
      if (expiryMs(entry.expires_at) === null) {
        return { ok: false, error: `"${key}.expires_at" must be an ISO-8601 timestamp` };
      }
      patch[key] = { value: value as boolean | number, expires_at: entry.expires_at as string };
      continue;
    }
    patch[key] = { value: value as boolean | number };
  }

  return { ok: true, patch: patch as EntitlementOverridePatch };
}
