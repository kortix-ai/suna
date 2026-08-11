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
