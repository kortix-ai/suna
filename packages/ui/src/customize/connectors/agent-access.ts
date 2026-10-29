import { parseManifestText } from '@kortix/manifest-schema';
import type { AgentGrantSet } from '@kortix/sdk';

/**
 * Which agents can use which connector, and with which rule set, read from
 * the root kortix.yaml (v2/v3): `agents.<a>.connectors` is the grant and
 * `agents.<a>.policy_sets.<slug>` the set. The connector page's Agents tab and
 * the Rules matrix both read this, and both write through `setAgentScope`.
 *
 * ponytail: agents declared in an `imports:` file are not read. Read the
 * merged grants from the API when it serves them (`GET …/connectors/{slug}/agents`).
 */
export interface AgentConnectorAccess {
  granted: boolean;
  /** The set the agent names on this connector, or null for the base rules. */
  policySet: string | null;
}

export interface AgentGrants {
  /** `all`, or the granted slugs. An absent grant is none (v2 denies by default). */
  connectors: 'all' | string[];
  policySets: Record<string, string>;
}

/** Every declared agent's connector grant and sets, by agent name. Null when the manifest is not v2/v3 YAML. */
export function manifestAgentGrants(manifestRaw: string | null | undefined): Record<string, AgentGrants> | null {
  if (!manifestRaw) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = parseManifestText(manifestRaw, 'yaml');
  } catch {
    return null;
  }
  const version = Number(manifest.kortix_version);
  const agents = manifest.agents;
  if (!(version >= 2)) return null;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return {};
  const out: Record<string, AgentGrants> = Object.create(null);
  for (const [name, block] of Object.entries(agents as Record<string, unknown>)) {
    const entry = (block && typeof block === 'object' ? block : {}) as {
      connectors?: unknown;
      policy_sets?: unknown;
    };
    const connectors =
      entry.connectors === 'all'
        ? 'all'
        : Array.isArray(entry.connectors)
          ? entry.connectors.filter((slug): slug is string => typeof slug === 'string')
          : [];
    const sets =
      entry.policy_sets && typeof entry.policy_sets === 'object' && !Array.isArray(entry.policy_sets)
        ? Object.fromEntries(
            Object.entries(entry.policy_sets as Record<string, unknown>).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string',
            ),
          )
        : {};
    out[name] = { connectors, policySets: sets };
  }
  return out;
}

export function agentConnectorAccess(grants: AgentGrants | undefined, slug: string): AgentConnectorAccess {
  if (!grants) return { granted: false, policySet: null };
  return {
    granted: grants.connectors === 'all' || grants.connectors.includes(slug),
    policySet: grants.policySets[slug] ?? null,
  };
}

/**
 * The agent's connector grant after giving or taking one connector. Taking one
 * from `all` lists every other connector the project has.
 */
export function withConnectorGrant(
  grants: AgentGrants | undefined,
  slug: string,
  on: boolean,
  allSlugs: readonly string[],
): AgentGrantSet {
  const current = grants?.connectors ?? [];
  if (current === 'all') return on ? 'all' : allSlugs.filter((other) => other !== slug);
  if (on) return current.includes(slug) ? current : [...current, slug];
  return current.filter((other) => other !== slug);
}

/** One rule set of a connector and how many agents use it. */
export interface RuleSetUsage {
  name: string;
  agents: number;
}

/** Each connector's rule sets (`connectors[].policy_sets`) with their agent count, by slug. */
export function connectorRuleSetUsage(manifestRaw: string | null | undefined): Record<string, RuleSetUsage[]> {
  const grants = manifestAgentGrants(manifestRaw);
  if (!grants || !manifestRaw) return {};
  let manifest: Record<string, unknown>;
  try {
    manifest = parseManifestText(manifestRaw, 'yaml');
  } catch {
    return {};
  }
  const out: Record<string, RuleSetUsage[]> = Object.create(null);
  for (const entry of Array.isArray(manifest.connectors) ? manifest.connectors : []) {
    const { slug, policy_sets: sets } = (entry ?? {}) as { slug?: unknown; policy_sets?: unknown };
    if (typeof slug !== 'string' || !sets || typeof sets !== 'object' || Array.isArray(sets)) continue;
    out[slug] = Object.keys(sets).map((name) => ({
      name,
      agents: Object.values(grants).filter((agent) => agent.policySets[slug] === name).length,
    }));
  }
  return out;
}
