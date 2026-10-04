/**
 * The agent-session facts the auth middleware put on the request: the agent
 * grant, the session binding, the on-behalf-of human. The rules that read
 * them live in `services/iam/agent-scope.ts` and
 * `services/iam/agent-grant-ceiling.ts`.
 */
import type { Context } from 'hono';
import type { Actor } from '../../services/iam/actor';
import type { GovernedAgentWriter } from '../../services/iam/agent-grant-ceiling';
import { type AgentGrant, agentMayPerform } from '../../services/iam/agent-scope';
import { buildDenialError } from '../../services/iam/denial-message';

/** Read the agent grant off the request context (set by the auth middleware). */
export function getAgentGrant(c: Context): AgentGrant | null {
  return (c.get('agentGrant') as AgentGrant | null | undefined) ?? null;
}

export function isProjectSessionPrincipal(c: Context): boolean {
  if (c.get('authType') === 'supabase') return false;
  return c.get('sessionId') != null || getAgentGrant(c) != null;
}

/**
 * A session that borrows a human's authority: a project session that is NOT a
 * governed agent principal (a null grant: `meta`, or a v1 project with no
 * `[[agents]]`). Its
 * permission check is the launcher's role, so routes keep their extra
 * agent-session refusals for it. A governed agent principal authorizes as its
 * own service account, so its permissions alone decide, like a human's.
 */
export function isBorrowedSessionPrincipal(c: Context): boolean {
  if (!isProjectSessionPrincipal(c)) return false;
  const credential = (c.get('actor') as { credential?: { kind?: string; agentPrincipal?: boolean } } | undefined)
    ?.credential;
  return !(credential?.kind === 'agent_session' && credential.agentPrincipal === true);
}

/**
 * Throw 403 if the request is an agent-session token whose grant does not
 * include `action`. No-op for non-agent tokens (null grant).
 */
export function assertAgentScope(c: Context, action: string): void {
  const grant = getAgentGrant(c);
  if (agentMayPerform(grant, action)) return;
  throw buildDenialError(
    action,
    'agent_scope_insufficient',
    `Agent "${grant!.agent}" is not granted "${action}". Add it to this agent's kortix_permissions in kortix.yaml (CR-merged).`,
  );
}

/** A governed agent principal: authorizes as its own service account (agent_principal on, non-null grant). */
export function isGovernedAgentWriter(c: Context): boolean {
  const credential = (c.get('actor') as Actor | undefined)?.credential as
    | { kind?: string; agentPrincipal?: boolean }
    | undefined;
  return credential?.kind === 'agent_session' && credential.agentPrincipal === true && getAgentGrant(c) !== null;
}

/** The governed writer `assertNoGrantEscalation` bounds, or null for every other caller. */
export function governedAgentWriter(c: Context): GovernedAgentWriter | null {
  if (!isGovernedAgentWriter(c)) return null;
  return { actor: c.get('actor') as Actor, grant: getAgentGrant(c)! };
}

/** Fresh per-request value set by the auth middleware; null for non-session tokens. */
export function getRequestOnBehalfOf(c: Context): string | null {
  return (c.get('onBehalfOfUserId') as string | null | undefined) ?? null;
}
