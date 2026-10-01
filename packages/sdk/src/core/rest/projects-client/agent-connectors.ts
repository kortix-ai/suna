// ── Required-connector canonicalization, shared by agent-config.ts (the v2
// agent-config editor) and agent-scope.ts (the v1 scope editor) ──
// `connectors_personal` is the deprecated input alias for `connectors_required`.
// Both surfaces canonicalize the pair the same way: normalize each list (trim,
// drop empties, dedupe), reject conflicting values, and serialize only the
// canonical field.

type ConnectorGrantBlock = {
  connectors_required?: string[];
  /** @deprecated Input alias for `connectors_required`. */
  connectors_personal?: string[];
};

function normalizeConnectorList(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const slug = value.trim();
    if (slug && !normalized.includes(slug)) normalized.push(slug);
  }
  return normalized;
}

function equalConnectorSets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((slug) => rightSet.has(slug));
}

export function canonicalizeRequiredConnectors<T extends ConnectorGrantBlock>(block: T): T {
  const canonical = block.connectors_required
    ? normalizeConnectorList(block.connectors_required)
    : undefined;
  const legacy = block.connectors_personal
    ? normalizeConnectorList(block.connectors_personal)
    : undefined;
  if (canonical && legacy && !equalConnectorSets(canonical, legacy)) {
    throw new Error(
      'connectors_personal must match connectors_required when both fields are present',
    );
  }
  const next = { ...block };
  delete next.connectors_personal;
  if (canonical !== undefined || legacy !== undefined) {
    next.connectors_required = canonical ?? legacy;
  }
  return next;
}
