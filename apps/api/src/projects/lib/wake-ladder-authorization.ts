/**
 * May this watcher still start and restart the session — asked RIGHT BEFORE
 * each server wake-ladder step, never once at stream open (Strix CWE-863 on
 * #9312). A stream can stay open for hours; a member removed from the project,
 * a demoted role, a revoked token or a withdrawn agent grant must stop the
 * ladder from spending compute in their name the moment it happens.
 *
 * The same gates `POST .../start` and `.../restart` apply, from fresh reads:
 * the token row (a PAT or an agent token: active, not revoked, not expired),
 * project access at the `session` floor, the session's lifecycle right (owner
 * or account owner/admin, not deleted), and the agent grant.
 */
import type { Actor } from '../../iam/actor';
import { validateAccountTokenById } from '../../repositories/account-tokens';
import type { StartSessionCommand } from '../session-lifecycle/types';
import { resolveAndAuthorizeAgentAs } from './agent-access';
import { authorizeProjectAccess, loadProjectRow } from './project-access';
import { loadVisibleSession, sessionIsTombstoned } from './session-visibility';

export interface WakeLadderAuthorization {
  actor: Actor;
  /** The stream request's `onBehalfOfUserId`. */
  onBehalfOf: string | null | undefined;
  isServiceAccount: boolean;
  userId: string;
  projectId: string;
  sessionId: string;
}

/** The fresh `{ loaded, visible }` a step runs as, or null when it may not run. */
export async function reauthorizeWakeLadderActor(
  input: WakeLadderAuthorization,
): Promise<Pick<StartSessionCommand, 'loaded' | 'visible'> | null> {
  try {
    const credential = input.actor.credential;
    if (credential.kind === 'pat' || credential.kind === 'agent_session') {
      if (!(await validateAccountTokenById(credential.tokenId)).isValid) return null;
    }
    const row = await loadProjectRow(input.projectId);
    if (!row) return null;
    const loaded = await authorizeProjectAccess({
      userId: input.userId,
      projectId: input.projectId,
      row,
      action: 'session',
      actor: input.actor,
      isServiceAccount: input.isServiceAccount,
      bypassHeaderPresent: false,
    });
    if (!loaded) return null;
    const visible = await loadVisibleSession(loaded, input.sessionId, null, null);
    if (!visible || sessionIsTombstoned(visible.row) || !visible.canManageLifecycle) return null;
    // Throws `403 agent_not_accessible` when the grant is gone.
    await resolveAndAuthorizeAgentAs(input.actor, input.onBehalfOf, loaded, input.projectId, null, visible.row.agentName);
    return { loaded, visible: { row: visible.row } };
  } catch {
    return null;
  }
}
