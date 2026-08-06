import type { AgentGrant } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { canonicalConnectorAlias } from '../shared/connector-alias';

/**
 * Agent-session scope enforcement — the `kortix_cli` half of per-agent
 * authorization.
 *
 * This runs BESIDE the role check (`assertAuthorized` / `loadProjectForUser`),
 * not inside the IAM engine (which stays role-only). The account token a
 * session presents carries a resolved `agentGrant` (see projects/agents.ts);
 * a route asserts the Kortix action it performs is in that grant. Combined with
 * the route's existing user-role check, the net effect is `userRole ∩ agentGrant`
 * — an agent can never exceed the human who launched it, nor its own grant.
 *
 * A null grant (non-agent token: laptop CLI PAT, dashboard session, or a project
 * that hasn't adopted `[[agents]]`) imposes no restriction.
 */

/** Read the agent grant off the request context (set by the auth middleware). */
export function getAgentGrant(c: Context): AgentGrant | null {
  return (c.get('agentGrant') as AgentGrant | null | undefined) ?? null;
}

export function isProjectSessionPrincipal(c: Context): boolean {
  if (c.get('authType') === 'supabase') return false;
  return c.get('sessionId') != null || getAgentGrant(c) != null;
}

/**
 * Synonym pairs for the change-request capability. A route gates CR creation as
 * `project.cr.open` but the central agent-grant fold (via assertProjectCapability)
 * gates the underlying commit as `project.gitops.push`; likewise CR merge is
 * `project.cr.merge` ≡ `project.gitops.merge`. Without aliasing an agent would
 * need BOTH spellings in its kortix_cli to open/merge a CR — a silent
 * double-gate. Granting EITHER member of a pair satisfies both checks.
 */
const AGENT_ACTION_ALIASES: Readonly<Record<string, string>> = {
  'project.cr.open': 'project.gitops.push',
  'project.gitops.push': 'project.cr.open',
  'project.cr.merge': 'project.gitops.merge',
  'project.gitops.merge': 'project.cr.merge',
};

const META_AGENT_DENIED_ACTIONS: ReadonlySet<string> = new Set([
  'project.cr.merge',
  'project.gitops.merge',
]);

/** True if the agent-session grant permits `action` (or there is no grant). */
export function agentMayPerform(grant: AgentGrant | null, action: string): boolean {
  if (!grant) return true; // no grant = no restriction
  // This principal-level deny protects sessions minted before the platform
  // grant was narrowed, including stale tokens stamped with `kortixCli: all`.
  if (isMetaAgentName(grant.agent) && META_AGENT_DENIED_ACTIONS.has(action)) return false;
  if (grant.kortixCli === 'all') return true;
  if (grant.kortixCli.includes(action)) return true;
  const alias = AGENT_ACTION_ALIASES[action];
  return alias ? grant.kortixCli.includes(alias) : false;
}

/**
 * Normalize a grant's connector list to CANONICAL slugs.
 *
 * Three gates compare this grant, and they historically saw three different
 * spellings of the same connector: the catalog compared the public alias
 * (`email`), the call gate the raw slug (`kortix_email`), and session create the
 * caller's binding key. With an exact `includes()` match, whichever spelling a
 * manifest author picked satisfied one gate and failed another —
 * `connectors: ["email"]` made the connector VISIBLE in the catalog and then
 * 403'd on call, which looks like a platform bug rather than a grant typo.
 *
 * Canonicalizing ONCE here means every gate can compare canonical-to-canonical.
 */
export function canonicalizeGrantConnectors(grant: AgentGrant | null): AgentGrant | null {
  if (!grant || grant.connectors === 'all') return grant;
  const canonical = grant.connectors.map((slug) => canonicalConnectorAlias(slug));
  return { ...grant, connectors: [...new Set(canonical)] };
}

/**
 * True if the agent-session grant permits calling connector `slug` (or no grant).
 *
 * `slug` MUST already be canonical — call `canonicalConnectorAlias` on anything
 * that came from a manifest, a request body, or a stored row first.
 */
export function agentMayUseConnector(grant: AgentGrant | null, slug: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.connectors === 'all') return true;
  return grant.connectors.includes(slug);
}

/** True if the agent may receive/read the project secret with this
 *  IDENTIFIER (or no grant). `env` is the grant's `secrets` allowlist — a list
 *  of secret IDENTIFIERS (not raw env-var keys; see project_secrets.identifier
 *  / resolveGrantedSecretEnv), optional for back-compat with tokens minted
 *  before the field existed — those are treated as 'all' (unrestricted). This
 *  is the SOLE gate on agent secret access — there is no resource-side
 *  allow-list on the secret itself. */
export function agentMayUseEnv(grant: AgentGrant | null, identifier: string): boolean {
  if (!grant) return true; // no grant = no restriction
  const env = grant.env ?? 'all';
  if (env === 'all') return true;
  // Identifiers are free-form-ish but a kortix.yaml `secrets:` allowlist
  // is hand-written and may use any case. Match case-insensitively so
  // `secrets: ["gmaps-primary"]` still admits identifier "GMAPS-primary".
  const target = identifier.toUpperCase();
  return env.some((e) => e.toUpperCase() === target);
}

/**
 * Throw 403 if the request is an agent-session token whose grant does not
 * include `action`. No-op for non-agent tokens (null grant).
 */
export function assertAgentScope(c: Context, action: string): void {
  const grant = getAgentGrant(c);
  if (agentMayPerform(grant, action)) return;
  throw new HTTPException(403, {
    message: `Agent "${grant!.agent}" is not granted "${action}". Add it to this agent's kortix_cli in kortix.yaml (CR-merged).`,
  });
}
