/**
 * Who uses which connector under which rules: every declared agent × every
 * connector profile. The Rules page and a connector's Agents tab read it.
 */
import type { AgentGrant } from '@kortix/db';
import { agentMayUseConnector, agentPolicySet } from '../iam/agent-scope';
import { canonicalConnectorAlias } from '../shared/connector-alias';

interface RulesMatrixCell {
  /** The agent's grant lists this connector (or `all`). */
  granted: boolean;
  /** The rule set it runs under here; null = the base rules. */
  policy_set: string | null;
  /** It names a set this connector does not define: every call is blocked. */
  policy_set_missing: boolean;
}

export interface RulesMatrix {
  connectors: Array<{ slug: string; name: string; policy_sets: string[] }>;
  agents: Array<{ agent: string; cells: Record<string, RulesMatrixCell> }>;
}

export function rulesMatrix(
  connectors: RulesMatrix['connectors'],
  grants: ReadonlyMap<string, AgentGrant>,
): RulesMatrix {
  const agents = [...grants.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, grant]) => {
      const cells: Record<string, RulesMatrixCell> = {};
      for (const connector of connectors) {
        const slug = canonicalConnectorAlias(connector.slug);
        const granted = agentMayUseConnector(grant, slug);
        const set = granted ? agentPolicySet(grant, slug) : null;
        cells[connector.slug] = {
          granted,
          policy_set: set,
          policy_set_missing: set !== null && !connector.policy_sets.includes(set),
        };
      }
      return { agent, cells };
    });
  return { connectors, agents };
}
