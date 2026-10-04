import type { Context } from 'hono';
import {
  ACTOR_CONTEXT_HEADER,
  type ActorContext,
  resolveActorFromRequest,
} from '../../services/router/actor-context';

/** The signed actor context a sandbox sent with this request, or null. */
export function requestActorContext(c: Context, logPrefix: string): ActorContext | null {
  // Most requests carry no actor context: answer before reading anything else.
  const actorContext = c.req.header(ACTOR_CONTEXT_HEADER);
  if (!actorContext) return null;
  return resolveActorFromRequest(
    {
      actorContext,
      authorization: c.req.header('Authorization') || c.req.header('authorization'),
      boundSandboxId: c.get('sandboxId') as string | undefined,
    },
    { logPrefix },
  );
}
