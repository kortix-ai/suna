export interface PreparationScope {
  mode: 'development-only';
  source_refs: string[];
  allow_source_lifecycle: false;
  allow_destination_writes: false;
}

/** Explicit source allowlist for the current preparation phase. No force/apply escape hatch. */
export function assertPreparationScope(value: unknown, ref: string): asserts value is PreparationScope {
  const scope = value as Partial<PreparationScope> | null;
  if (!scope || scope.mode !== 'development-only' || scope.allow_source_lifecycle !== false || scope.allow_destination_writes !== false) {
    throw new Error('Preparation requires development-only scope with remote writes disabled');
  }
  if (!Array.isArray(scope.source_refs) || !scope.source_refs.every(v => typeof v === 'string' && /^[a-z]{20}$/.test(v))) {
    throw new Error('Invalid development source allowlist');
  }
  if (!scope.source_refs.includes(ref)) throw new Error('Source is outside the approved development scope');
}
