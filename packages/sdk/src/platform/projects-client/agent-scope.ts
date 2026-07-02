import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ── Agent scope (the inheritance pyramid's declaration step) ───────────────
// Bind specific secrets + connectors to an agent by writing its
// `[[agents]].env` / `.connectors` allowlists into kortix.toml. Members
// assigned to that agent (Members → Resource access) inherit exactly this set.
// Manager-gated server-side. `kortix_cli` is deliberately not settable here.

/** `'all'` = every item the launcher can see; a list = allowlist; `[]` = none. */
export type AgentGrantSet = string[] | 'all';

export async function setAgentScope(
  projectId: string,
  agentName: string,
  scope: { env?: AgentGrantSet; connectors?: AgentGrantSet },
) {
  return unwrap(
    await backendApi.put<{
      ok: boolean;
      agent: string;
      env: AgentGrantSet;
      connectors: AgentGrantSet;
    }>(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/scope`, scope),
  );
}
