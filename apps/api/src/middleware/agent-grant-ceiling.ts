/**
 * The grant-escalation gate as route handlers call it: the governed agent
 * writer read off the request. The escalation rule is `assertNoGrantEscalationBy`
 * in `iam/agent-grant-ceiling.ts`, which re-exports these names.
 *
 * A module of its own, apart from `agent-scope.ts`: `iam/agent-scope.ts`
 * re-exports that one, and an import of the IAM engine from there would load
 * it into every suite that mocks `iam/actor` with a partial shape.
 */
import type { Context } from 'hono';
import type { AgentGrant } from '@kortix/db';
import type { Actor } from '../iam/actor';
import { assertNoGrantEscalationBy, type GovernedAgentWriter } from '../iam/agent-grant-ceiling';
import { getAgentGrant } from './agent-scope';

/** A governed agent principal: authorizes as its own service account (agent_principal on, non-null grant). */
export function isGovernedAgentWriter(c: Context): boolean {
  const credential = (c.get('actor') as Actor | undefined)?.credential as
    | { kind?: string; agentPrincipal?: boolean }
    | undefined;
  return credential?.kind === 'agent_session' && credential.agentPrincipal === true && getAgentGrant(c) !== null;
}

/** The governed writer `assertNoGrantEscalationBy` bounds, or null for every other caller. */
export function governedAgentWriter(c: Context): GovernedAgentWriter | null {
  if (!isGovernedAgentWriter(c)) return null;
  return { actor: c.get('actor') as Actor, grant: getAgentGrant(c)! };
}

/**
 * 403 `agent_grant_escalation` when a governed agent's write would give any
 * agent a permission, connector, secret or App the writer does not hold. A
 * no-op for every other caller.
 */
export async function assertNoGrantEscalation(
  c: Context,
  projectId: string,
  before: Map<string, AgentGrant>,
  after: Map<string, AgentGrant>,
): Promise<void> {
  await assertNoGrantEscalationBy(governedAgentWriter(c), projectId, before, after);
}
