import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { actorOf } from '../../iam/actor';
import { assertActorMayRunAgent, resolveAndAuthorizeAgentAs, type ResolvedAgentAccess } from './agent-access';

/**
 * The request's fresh on-behalf-of user. The auth middleware reads it on every
 * request; undefined (not null) when it set nothing.
 */
function requestOnBehalfOf(c: Context): string | null | undefined {
  return c.get('onBehalfOfUserId') as string | null | undefined;
}

/**
 * Resolve the agent for a session/prompt and authorize it for this request,
 * or throw the 403 the user can act on. See `resolveAndAuthorizeAgentAs`.
 */
export async function resolveAndAuthorizeAgent(
  c: Context,
  loaded: { row: any; userId: string },
  projectId: string,
  requestedAgent?: unknown,
  sessionAgent?: unknown,
  action = 'project.session.start',
): Promise<ResolvedAgentAccess> {
  const actor = await actorOf(c, loaded.row.accountId);
  return resolveAndAuthorizeAgentAs(actor, requestOnBehalfOf(c), loaded, projectId, requestedAgent, sessionAgent, action);
}

/**
 * May the caller run agent `agentName`? Throws `403 agent_not_accessible`
 * naming `action` when not. See `assertActorMayRunAgent`.
 */
export async function assertMayRunAgent(
  c: Context,
  accountId: string,
  projectId: string,
  agentName: string,
  action: string,
): Promise<void> {
  const actor = await actorOf(c, accountId);
  await assertActorMayRunAgent(actor, requestOnBehalfOf(c), projectId, agentName, action);
}

/**
 * The same question, asked without a 403.
 *
 * For a SPECULATIVE, unrequested action — warming a session the user has not
 * asked for — a denial is not news the caller needs. The route turns a `false`
 * into its ordinary "nothing available" response, so a member who cannot run an
 * agent simply gets no warm box, instead of a red 403 on every page load for
 * doing nothing.
 *
 * Only for actions the user did not initiate. Anything the user actually asked
 * for goes through `resolveAndAuthorizeAgent`, which explains itself.
 */
export async function canUseAnyAgent(
  c: Context,
  loaded: { row: any; userId: string },
  projectId: string,
): Promise<boolean> {
  try {
    await resolveAndAuthorizeAgent(c, loaded, projectId);
    return true;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return false;
    throw error;
  }
}

