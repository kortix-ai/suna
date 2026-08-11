import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── Agent scope (the inheritance pyramid's declaration step) ───────────────
// Bind specific secrets + connectors to an agent by writing its
// `agents.<name>.env` / `.connectors` allowlists into kortix.yaml. Members
// assigned to that agent (Members → Resource access) inherit exactly this set.
// Manager-gated server-side. `kortix_cli` is deliberately not settable here.

/** `'all'` = every item the launcher can see; a list = allowlist; `[]` = none. */
export type AgentGrantSet = string[] | 'all';

export async function setAgentScope(
  workspaceId: string,
  agentName: string,
  scope: {
    env?: AgentGrantSet;
    connectors?: AgentGrantSet;
    connectors_required?: string[];
    /** @deprecated Input alias for `connectors_required`. */
    connectors_personal?: string[];
  },
) {
  const canonicalScope = canonicalizeRequiredConnectors(scope);
  return unwrap(
    await backendApi.put<{
      ok: boolean;
      agent: string;
      env: AgentGrantSet;
      connectors: AgentGrantSet;
      connectors_required: string[];
    }>(`/projects/${workspaceId}/agents/${encodeURIComponent(agentName)}/scope`, canonicalScope),
  );
}

type AgentScopeUpdate = Parameters<typeof setAgentScope>[2];

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

function canonicalizeRequiredConnectors(scope: AgentScopeUpdate): AgentScopeUpdate {
  const canonical = scope.connectors_required
    ? normalizeConnectorList(scope.connectors_required)
    : undefined;
  const legacy = scope.connectors_personal
    ? normalizeConnectorList(scope.connectors_personal)
    : undefined;
  if (canonical && legacy && !equalConnectorSets(canonical, legacy)) {
    throw new Error('connectors_personal must match connectors_required when both fields are present');
  }
  const next = { ...scope };
  delete next.connectors_personal;
  if (canonical !== undefined || legacy !== undefined) {
    next.connectors_required = canonical ?? legacy;
  }
  return next;
}
