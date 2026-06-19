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

/** True if the agent-session grant permits `action` (or there is no grant). */
export function agentMayPerform(grant: AgentGrant | null, action: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.kortixCli === 'all') return true;
  return grant.kortixCli.includes(action);
}

/** True if the agent-session grant permits calling connector `slug` (or no grant). */
export function agentMayUseConnector(grant: AgentGrant | null, slug: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.connectors === 'all') return true;
  return grant.connectors.includes(slug);
}

/**
 * Throw 403 if the request is an agent-session token whose grant does not
 * include `action`. No-op for non-agent tokens (null grant).
 */
export function assertAgentScope(c: Context, action: string): void {
  const grant = getAgentGrant(c);
  if (agentMayPerform(grant, action)) return;
  throw new HTTPException(403, {
    message: `Agent "${grant!.agent}" is not granted "${action}". Add it to this agent's kortix_cli in kortix.toml (CR-merged).`,
  });
}
