/**
 * One session-access guard for session-scoped routes.
 *
 * A route that acts on `/:projectId/sessions/:sessionId/...` must answer the
 * same questions in the same order: is the session in the authorized project,
 * may this caller see it, is it deleted, and may this caller do the verb. The
 * pieces live in `access.ts` (`loadVisibleSession`, `loadSessionForSharing`,
 * `sessionIsTombstoned`). This module composes them, and it reads the caller's
 * session binding from the request itself through `callerKortixSessionId(c)`.
 * A route therefore never chooses between the raw `c.get('sessionId')` (the
 * Supabase LOGIN session for a signed-in human) and the Kortix binding.
 *
 * Call it after `loadProjectForUser(c, projectId, …)`: the project gate
 * authorizes the path project, and every lookup here is scoped to that
 * project's row, so a session of another project or account is `404`.
 */
import type { Context } from 'hono';
import { PUBLIC_SHARE_OWNER_ONLY_ERROR } from '../../connectors/share';
import { loadSessionForSharing, loadVisibleSession, sessionIsTombstoned } from './access';
import { callerKortixSessionId } from './caller-session';

type LoadedProject = Parameters<typeof loadVisibleSession>[0];
type VisibleSession = NonNullable<Awaited<ReturnType<typeof loadVisibleSession>>>;
type SharingSession = NonNullable<Awaited<ReturnType<typeof loadSessionForSharing>>>;

/**
 * `read`: the caller may see the session.
 * `lifecycle`: the caller may stop, start, or reconfigure the session's
 * compute. The session owner and a project manager qualify. A session-bound
 * credential also qualifies for its OWN session, and never for another one.
 */
export type SessionNeed = 'read' | 'lifecycle';

/**
 * `list` and `revoke` are manager-tier: revoking only removes access.
 * `mint` is owner-governed (see `mayManageSessionSharing`): a public link is
 * unauthenticated, so it is never a way around the visibility gate.
 */
export type SessionShareNeed = 'list' | 'mint' | 'revoke';

export interface SessionAccessDenial {
  ok: false;
  status: 403 | 404;
  error: string;
}

const NOT_FOUND: SessionAccessDenial = { ok: false, status: 404, error: 'Not found' };

export async function guardSession(
  c: Context,
  loaded: LoadedProject,
  sessionId: string,
  need: SessionNeed,
): Promise<{ ok: true; session: VisibleSession } | SessionAccessDenial> {
  const binding = callerKortixSessionId(c);
  const session = await loadVisibleSession(loaded, sessionId, binding, binding);
  if (!session || sessionIsTombstoned(session.row)) return NOT_FOUND;
  if (need === 'lifecycle' && !session.canManageLifecycle && binding !== sessionId) {
    return {
      ok: false,
      status: 403,
      error: 'Only the session owner or a project manager can manage this session',
    };
  }
  return { ok: true, session };
}

export async function guardSessionSharing(
  c: Context,
  loaded: LoadedProject,
  sessionId: string,
  need: SessionShareNeed,
): Promise<{ ok: true; session: SharingSession } | SessionAccessDenial> {
  const session = await loadSessionForSharing(loaded, sessionId, callerKortixSessionId(c));
  if (!session) return NOT_FOUND;
  if (need === 'mint') {
    if (sessionIsTombstoned(session.row)) return NOT_FOUND;
    if (!session.canManageSharing) return { ok: false, status: 403, error: PUBLIC_SHARE_OWNER_ONLY_ERROR };
  } else if (!session.canManageLifecycle) {
    return {
      ok: false,
      status: 403,
      error:
        need === 'list'
          ? 'Only the session owner or a project manager can view public shares'
          : 'Only the session owner or a project manager can revoke public shares',
    };
  }
  return { ok: true, session };
}

/** Send a guard denial as the route's JSON error response. */
export function sessionAccessDenied(c: Context, denial: SessionAccessDenial): Response {
  return c.json({ error: denial.error }, denial.status);
}
