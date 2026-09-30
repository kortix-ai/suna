import { createHash } from 'node:crypto';
import { SESSION_SECRETS_ALLOWLIST_MAX_KEYS } from '@kortix/api-contract';
import type { ResolvedProjectSecret } from '../secrets';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
const IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_REGEX.test(name);
}

/** A secret's `identifier` — the unique-per-project handle agents grant + the
 *  UI shows. More permissive than the env-var-shaped `name` (KEY): letters,
 *  digits, `_`, `.`, `-`, starting with an alphanumeric, max 128 chars. */
export function isValidIdentifier(identifier: string): boolean {
  return IDENTIFIER_REGEX.test(identifier);
}

/**
 * True if writing `newKey` under an identifier that ALREADY exists with a
 * DIFFERENT key (`existingKey`) would silently retarget it — an identifier is
 * a stable handle (agents grant it, the DB uniquely keys on it), so redefining
 * its underlying env-var KEY via upsert is rejected rather than allowed as a
 * surprising in-place swap. `existingKey === null` means no row exists yet
 * (never a conflict — this is the create path).
 */
export function identifierKeyConflicts(existingKey: string | null, newKey: string): boolean {
  return existingKey !== null && existingKey !== newKey;
}

/**
 * Thrown when an agent's EXPLICIT `secrets` grant (a concrete identifier list,
 * not `'all'`) names two-or-more identifiers that resolve to the SAME env var
 * KEY — there's no principled way to pick a winner for a deliberate selection,
 * so this is a configuration error the caller must surface, not silently
 * resolve. An `'all'` grant never throws (see resolveGrantedSecretEnv).
 */
export class AmbiguousSecretGrantError extends Error {
  constructor(
    public readonly key: string,
    public readonly identifiers: string[],
  ) {
    super(
      `secrets grant is ambiguous: key "${key}" is provided by multiple granted identifiers (${identifiers.join(', ')})`,
    );
    this.name = 'AmbiguousSecretGrantError';
  }
}

/**
 * The whole security decision for injecting secrets into an agent's sandbox
 * env: given every secret resolved for the launching user (by identifier) and
 * the running agent's `secrets` grant, which identifiers are allowed and what
 * KEY=value env results. Pure — DB-free, fully unit-testable.
 *
 *   grant === undefined | 'all' → every identifier is allowed. If two allowed
 *     identifiers share a KEY (e.g. GMAPS-primary / GMAPS-backup both
 *     GOOGLE_MAPS_API_KEY), a deterministic winner is picked (identifier sort
 *     order) rather than erroring — 'all' is a default, not a deliberate
 *     per-identifier choice.
 *   grant === string[] (explicit list, case-insensitive match on identifier)
 *     → only those identifiers are allowed. Two ALLOWED identifiers sharing a
 *     KEY is an AmbiguousSecretGrantError — a deliberate list naming both is a
 *     misconfiguration, not something to silently resolve.
 */
/** Sort key among values of one KEY: a value narrowed to and shared with this
 *  session's person (`audience: 'in'`) before one shared with everyone. */
export function secretAudienceRank(audience: ResolvedProjectSecret['audience']): number {
  return audience === 'in' ? 0 : 1;
}

export function resolveGrantedSecretSelection(
  rows: ResolvedProjectSecret[],
  grant: string[] | 'all' | undefined,
): {
  env: Record<string, string>;
  identifiers: string[];
  selected: ResolvedProjectSecret[];
} {
  const allowAll = grant === undefined || grant === 'all';
  const allowSet = allowAll ? null : new Set(grant.map((g) => g.toUpperCase()));
  const allowed = allowAll ? rows : rows.filter((r) => allowSet!.has(r.identifier.toUpperCase()));

  const byKey = new Map<string, ResolvedProjectSecret[]>();
  for (const row of allowed) {
    const list = byKey.get(row.key) ?? [];
    list.push(row);
    byKey.set(row.key, list);
  }

  const env: Record<string, string> = {};
  const selected: ResolvedProjectSecret[] = [];
  for (const [key, all] of byKey) {
    // A value shared with this session's person outranks one shared with
    // everyone (secret-audience.ts); only the best rank competes below.
    const best = Math.min(...all.map((c) => secretAudienceRank(c.audience)));
    const candidates = all.filter((c) => secretAudienceRank(c.audience) === best);
    if (candidates.length === 1) {
      env[key] = candidates[0]!.value;
      selected.push(candidates[0]!);
      continue;
    }
    if (!allowAll) {
      throw new AmbiguousSecretGrantError(key, candidates.map((c) => c.identifier).sort());
    }
    const winner = [...candidates].sort((a, b) => a.identifier.localeCompare(b.identifier))[0]!;
    env[key] = winner.value;
    selected.push(winner);
  }

  return { env, identifiers: allowed.map((r) => r.identifier), selected };
}

export function resolveGrantedSecretEnv(
  rows: ResolvedProjectSecret[],
  grant: string[] | 'all' | undefined,
): { env: Record<string, string>; identifiers: string[] } {
  const { env, identifiers } = resolveGrantedSecretSelection(rows, grant);
  return { env, identifiers };
}

// Single source of truth in @kortix/api-contract (route-contract validation);
// re-exported here so internal callers keep the same import site.
export { SESSION_SECRETS_ALLOWLIST_MAX_KEYS };

/**
 * Shape-validate a session-create body's `secrets` field (the per-session
 * allowlist). Pure — no DB. `undefined` (absent) → { ok, value: undefined };
 * anything present must be an array of ≤128 valid secret identifiers. Mirrors
 * parseSessionConnectorBindings so every createProjectSession caller (incl. the
 * internal ones that bypass the api-contract) gets the same guardrail.
 */
export function parseSessionSecretsAllowlist(
  raw: unknown,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'secrets must be an array of identifiers' };
  if (raw.length > SESSION_SECRETS_ALLOWLIST_MAX_KEYS) {
    return {
      ok: false,
      error: `secrets may contain at most ${SESSION_SECRETS_ALLOWLIST_MAX_KEYS} identifiers`,
    };
  }
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isValidIdentifier(entry)) {
      return {
        ok: false,
        error: `invalid secret identifier: ${String(entry)}`,
      };
    }
  }
  return { ok: true, value: raw as string[] };
}

/**
 * Narrow an agent's secret grant by a per-session allowlist (Kortix-as-a-Backend).
 * The result is ALWAYS a subset of what `grant` alone would allow — this is a
 * pure NARROWING, never a widening, so it can be composed with the existing
 * agent-grant/reserved-name/connector-scope filters without weakening any of
 * them. Pure — DB-free, fully unit-testable.
 *
 *   allowlist == null | undefined → return `grant` unchanged (no session
 *     restriction; byte-identical to the pre-KaaB path).
 *   grant == undefined | 'all'    → return `allowlist` (the session list
 *     becomes the explicit grant — narrowing from "every secret" to the named
 *     set). `[]` therefore means inject ZERO project secrets.
 *   both lists                    → case-insensitive intersection (only
 *     identifiers named in BOTH survive).
 */
export function intersectSecretGrants(
  grant: string[] | 'all' | undefined,
  allowlist: string[] | null | undefined,
): string[] | 'all' | undefined {
  if (allowlist === null || allowlist === undefined) return grant;
  if (grant === undefined || grant === 'all') return allowlist;
  const grantUpper = new Set(grant.map((g) => g.toUpperCase()));
  return allowlist.filter((id) => grantUpper.has(id.toUpperCase()));
}

/**
 * Detect an env-KEY collision AMONG the allowlisted identifiers, using rows
 * already resolved for the project. Two distinct identifiers naming the same
 * env KEY (e.g. GMAPS_PRIMARY / GMAPS_BACKUP → GOOGLE_MAPS_API_KEY) are a valid
 * project config, but naming BOTH in one session allowlist makes the boot-time
 * resolver throw AmbiguousSecretGrantError — and because the allowlist is
 * immutable, that permanently bricks the session. Surfacing it here lets create
 * reject with a clean 409 the caller can fix. Conservative: ignores the agent
 * grant (which could have dropped one), so it may reject a shade more than the
 * boot resolver strictly would — deterministic, cheap, and fail-closed. Pure.
 * Returns the first colliding { key, identifiers } (identifiers sorted) or null.
 */
export function secretKeyCollisionInAllowlist(
  rows: ResolvedProjectSecret[],
  allowlist: string[],
): { key: string; identifiers: string[] } | null {
  const allowUpper = new Set(allowlist.map((id) => id.toUpperCase()));
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    if (!allowUpper.has(row.identifier.toUpperCase())) continue;
    const ids = byKey.get(row.key) ?? [];
    ids.push(row.identifier);
    byKey.set(row.key, ids);
  }
  for (const [key, identifiers] of byKey) {
    if (identifiers.length > 1) return { key, identifiers: [...identifiers].sort() };
  }
  return null;
}

/**
 * Canonical form of a secrets allowlist for idempotency-conflict comparison:
 * upper-cased (identifier matching is case-insensitive), de-duplicated, sorted.
 * null/undefined → null (absence is distinct from an empty list).
 */
export function canonicalizeSecretsAllowlist(
  allowlist: string[] | null | undefined,
): string[] | null {
  if (allowlist === null || allowlist === undefined) return null;
  return [...new Set(allowlist.map((id) => id.toUpperCase()))].sort();
}

/**
 * True if two secrets allowlists differ meaningfully (order/case/dupes ignored)
 * — a replayed idempotent create naming a DIFFERENT secret set must conflict
 * rather than silently reuse the first. Mirrors connectorBindingPayloadConflicts.
 */
export function secretsAllowlistPayloadConflicts(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  const ca = canonicalizeSecretsAllowlist(a);
  const cb = canonicalizeSecretsAllowlist(b);
  if (ca === null || cb === null) return ca !== cb;
  return ca.length !== cb.length || ca.some((id, i) => id !== cb[i]);
}

export function projectSecretsRevision(env: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}
