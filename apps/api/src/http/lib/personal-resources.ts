/**
 * Personal-resource reach as the HTTP layer reads it: the request's Actor,
 * its fresh on_behalf_of and its session binding, handed to
 * `services/projects/lib/personal-resources.ts`.
 */
import type { Context } from 'hono';
import type { Actor } from '../../services/iam/actor';
import type { ConnectionAgentPrincipalReach } from '../../services/projects/lib/connection-access';
import { agentPrincipalReach, personalResourceOwner } from '../../services/projects/lib/personal-resources';
import { getRequestOnBehalfOf } from './agent-scope';

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
  return agentPrincipalReach({
    actor: actor ?? ((c.get('actor') as Actor | undefined) ?? null),
    onBehalfOfUserId: getRequestOnBehalfOf(c),
    sessionId: (c.get('sessionId') as string | undefined) ?? null,
  });
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
