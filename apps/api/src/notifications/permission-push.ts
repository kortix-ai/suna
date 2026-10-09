// Permission notification gate: the sandbox relays the harness's permission
// ask to `POST /turn-permission` (projects/routes/turn-permissions.ts). A
// daemon retry or an SSE replay repeats the same request id, so this notifies
// once per (session, request id). The claim is a `kortix.permission_push_claims`
// row, shared by every API replica: an in-process set notified once per replica.
import { permissionPushClaims } from '@kortix/db';
import { logger as defaultLogger } from '../lib/logger';
import { db } from '../shared/db';
import { notifySessionEvent, type SessionPushEvent } from './session-push';

/** Who the ask is for, beyond the session itself (projects/lib/notification-recipients.ts). */
export type PermissionAskContext = Pick<
  SessionPushEvent,
  'prompterUserId' | 'originClass' | 'isChild' | 'triggerWatcherIds'
>;

export interface PermissionPushRequest {
  sessionId: string;
  projectId: string;
  requestId: string;
  /** Resolved only after this call wins the claim, off the relay's response path. */
  context?: () => Promise<PermissionAskContext>;
}

export interface PermissionPushGateDeps {
  /** True when this call is the first for (session, request id). */
  claim?: (sessionId: string, requestId: string) => Promise<boolean>;
  notify?: (event: SessionPushEvent) => Promise<unknown>;
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
  const logger = deps.logger ?? defaultLogger;

  return {
    /** Claims the request id, then notifies without awaiting it.
     *  Resolves true when this call dispatched the notification. */
    async notify(req: PermissionPushRequest): Promise<boolean> {
      if (!(await claim(req.sessionId, req.requestId))) return false;
      void (async () => {
        const context = req.context ? await req.context() : {};
        await notify({ type: 'permission', sessionId: req.sessionId, projectId: req.projectId, requestId: req.requestId, ...context });
      })().catch((err) =>
        logger.warn('[push] permission notification failed', err instanceof Error ? err.message : err),
      );
      return true;
    },
  };
}

export const permissionPushGate = createPermissionPushGate();
