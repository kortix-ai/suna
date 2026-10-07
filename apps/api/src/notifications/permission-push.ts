// Permission push gate: the sandbox relays OpenCode `permission.asked` to
// `POST /turn-permission` (projects/routes/turn-permissions.ts). A daemon retry
// or an SSE replay repeats the same request id, so this sends one push per
// (session, request id). The claim is a `kortix.permission_push_claims` row,
// shared by every API replica: an in-process set pushed once per replica.
import { permissionPushClaims } from '@kortix/db';
import { db } from '../shared/db';
import { notifySessionEvent, type SessionPushEvent, type SessionPushOutcome } from './session-push';

export interface PermissionPushRequest {
  sessionId: string;
  projectId: string;
  requestId: string;
}

export interface PermissionPushGateDeps {
  /** True when this call is the first for (session, request id). */
  claim?: (sessionId: string, requestId: string) => Promise<boolean>;
  notify?: (event: SessionPushEvent) => Promise<SessionPushOutcome>;
  logger?: Pick<Console, 'warn'>;
}

async function claimInDatabase(sessionId: string, requestId: string): Promise<boolean> {
  const rows = await db
    .insert(permissionPushClaims)
    .values({ sessionId, requestId })
    .onConflictDoNothing()
    .returning({ sessionId: permissionPushClaims.sessionId });
  return rows.length > 0;
}

export function createPermissionPushGate(deps: PermissionPushGateDeps = {}) {
  const claim = deps.claim ?? claimInDatabase;
  const notify = deps.notify ?? notifySessionEvent;
  const logger = deps.logger ?? console;

  return {
    /** Claims the request id, then dispatches the push without awaiting it.
     *  Resolves true when this call dispatched a push. */
    async notify(req: PermissionPushRequest): Promise<boolean> {
      if (!(await claim(req.sessionId, req.requestId))) return false;
      void notify({ type: 'permission', sessionId: req.sessionId, projectId: req.projectId }).catch((err) =>
        logger.warn('[push] permission notification failed', err instanceof Error ? err.message : err),
      );
      return true;
    },
  };
}

export const permissionPushGate = createPermissionPushGate();
