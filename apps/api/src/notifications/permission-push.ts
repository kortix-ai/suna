// Permission push gate: the sandbox relays OpenCode `permission.asked` to
// `POST /turn-permission` (projects/routes/turn-permissions.ts). A daemon retry
// or an SSE replay repeats the same request id, so this sends one push per
// (session, request id). The seen set is in-process and bounded: a restart or
// an eviction can at worst repeat one push, never lose one.
import { notifySessionEvent, type SessionPushEvent, type SessionPushOutcome } from './session-push';

export const PERMISSION_DEDUPE_LIMIT = 500;

export interface PermissionPushRequest {
  sessionId: string;
  projectId: string;
  requestId: string;
}

export interface PermissionPushGateDeps {
  limit?: number;
  notify?: (event: SessionPushEvent) => Promise<SessionPushOutcome>;
  logger?: Pick<Console, 'warn'>;
}

export function createPermissionPushGate(deps: PermissionPushGateDeps = {}) {
  const limit = deps.limit ?? PERMISSION_DEDUPE_LIMIT;
  const notify = deps.notify ?? notifySessionEvent;
  const logger = deps.logger ?? console;
  // Map keeps insertion order: the first key is the least recently seen.
  const seen = new Map<string, true>();

  return {
    /** Fire-and-forget. Returns true when this call dispatched a push. */
    notify(req: PermissionPushRequest): boolean {
      const key = `${req.sessionId}\u0000${req.requestId}`;
      if (seen.has(key)) {
        seen.delete(key);
        seen.set(key, true);
        return false;
      }
      seen.set(key, true);
      while (seen.size > limit) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      void notify({ type: 'permission', sessionId: req.sessionId, projectId: req.projectId }).catch((err) =>
        logger.warn('[push] permission notification failed', err instanceof Error ? err.message : err),
      );
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}

export const permissionPushGate = createPermissionPushGate();
