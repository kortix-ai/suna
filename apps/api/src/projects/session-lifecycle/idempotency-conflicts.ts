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
