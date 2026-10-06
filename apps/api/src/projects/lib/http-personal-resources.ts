import type { Context } from 'hono';
import type { Actor } from '../../iam/actor';
import { getRequestOnBehalfOf } from '../../middleware/on-behalf-of';
import type { ConnectionAgentPrincipalReach } from './connection-access';
import { agentPrincipalReach, personalResourceOwner } from './personal-resources';

/**
 * Request-time reach of an agent-principal credential, in the shape
 * `connectionIsReachable({ agentPrincipal })` takes: the fresh on_behalf_of
 * and the visibility of the credential's own session. Null for every legacy
 * or human caller, which keeps their rule unchanged.
 */
export async function requestAgentPrincipalReach(
  c: Context,
  actor?: Actor | null,
): Promise<ConnectionAgentPrincipalReach | null> {
  const resolvedActor = actor ?? ((c.get('actor') as Actor | undefined) ?? null);
  return agentPrincipalReach(
    resolvedActor,
    getRequestOnBehalfOf(c),
    (c.get('sessionId') as string | undefined) ?? null,
  );
}

/**
 * Request-time owner of personal resources for a project route: the caller
 * (`loaded.userId`) for a human or legacy credential; under the
 * agent-principal model the on-behalf-of human of a private session, else
 * null (shared resources only).
 */
export async function requestPersonalOwner(
  c: Context,
  loaded: { userId: string; actor?: Actor | null },
): Promise<string | null> {
  const reach = await requestAgentPrincipalReach(c, loaded.actor ?? null);
  if (!reach) return loaded.userId;
  return personalResourceOwner({
    agentPrincipal: true,
    legacyUserId: loaded.userId,
    onBehalfOfUserId: reach.onBehalfOfUserId,
    visibility: reach.visibility,
  });
}
