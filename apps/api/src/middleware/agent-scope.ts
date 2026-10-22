/**
 * The agent-session scope readers: the agent grant and session binding the
 * auth middleware put on the request. The grant predicates they apply live in
 * `iam/agent-scope.ts`, which re-exports these names.
 */
import type { Context } from 'hono';
import type { AgentGrant } from '@kortix/db';
import { assertAgentGrantAllows } from '../iam/agent-scope';

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
  assertAgentGrantAllows(getAgentGrant(c), action);
}
