/**
 * Idempotency identity conflicts.
 *
 * A `create_session` replayed under the same idempotency key but with a DIFFERENT
 * end-user identity must not silently return the first caller's session. Within a
 * single backend account (the Kortix-as-a-Backend model — one account, many of
 * the wrapper's end-users) `origin_ref` is how the wrapper distinguishes its
 * end-users, and `runtime_context` carries that end-user's context. Returning the
 * stored session on a mismatch would land end-user B's prompts in end-user A's
 * conversation and misattribute usage/audit to A — a within-account cross-end-user
 * disclosure. These guards refuse the replay (409), mirroring the connector- and
 * secrets-allowlist conflict guards.
 *
 * Deny-by-default: absent-vs-present counts as a conflict. A well-behaved retry
 * replays the byte-identical body, so an omitted field on a replay is a genuine
 * change of intent, not a benign retry.
 */

function normalizeOriginRef(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function originRefConflicts(existing: unknown, requested: unknown): boolean {
  return normalizeOriginRef(existing) !== normalizeOriginRef(requested);
}

/** Order-independent canonical form of a runtime_context scalar map. */
function canonicalRuntimeContext(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value ?? null);
  const obj = value as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]] as const),
  );
}

export function runtimeContextConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalRuntimeContext(existing) !== canonicalRuntimeContext(requested);
}

/**
 * Order-independent, deduped canonical form of a `require_connectors` alias list.
 * An absent field and an empty list both normalize to "" (no requirements), so a
 * benign retry never conflicts; a genuinely different required set does.
 */
function canonicalRequireConnectors(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const aliases = Array.from(
    new Set(value.filter((a): a is string => typeof a === 'string' && a.length > 0)),
  ).sort();
  return aliases.length === 0 ? '' : JSON.stringify(aliases);
}

export function requireConnectorsConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalRequireConnectors(existing) !== canonicalRequireConnectors(requested);
}
