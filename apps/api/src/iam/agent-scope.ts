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
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { AgentGrant } from '@kortix/db';

/** Read the agent grant off the request context (set by the auth middleware). */
export function getAgentGrant(c: Context): AgentGrant | null {
  return (c.get('agentGrant') as AgentGrant | null | undefined) ?? null;
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

/** True if the agent-session grant permits `action` (or there is no grant). */
export function agentMayPerform(grant: AgentGrant | null, action: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.kortixCli === 'all') return true;
  if (grant.kortixCli.includes(action)) return true;
  const alias = AGENT_ACTION_ALIASES[action];
  return alias ? grant.kortixCli.includes(alias) : false;
}

/** True if the agent-session grant permits calling connector `slug` (or no grant). */
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
