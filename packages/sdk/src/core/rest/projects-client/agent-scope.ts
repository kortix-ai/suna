import { backendApi } from '../../http/api-client';
import { canonicalizeRequiredConnectors } from './agent-connectors';
import { unwrap } from './shared';

// ── Agent scope (the inheritance pyramid's declaration step) ───────────────
// Bind specific secrets + connectors to an agent by writing its
// `agents.<name>.env` / `.connectors` allowlists into kortix.yaml. Members
// assigned to that agent (Members → Resource access) inherit exactly this set.
// Manager-gated server-side. `kortix_permissions` is deliberately not settable here.

/** `'all'` = every item the launcher can see; a list = allowlist; `[]` = none. */
export type AgentGrantSet = string[] | 'all';

export async function setAgentScope(
  projectId: string,
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
    }>(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/scope`, canonicalScope),
  );
}
