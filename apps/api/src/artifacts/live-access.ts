/**
 * The view check of an Artifact's live socket, without a Hono context
 * (KRTX-3669). The upgrade runs in `Bun.serve`'s fetch before Hono, and the
 * re-check runs on a timer, so neither has a request to read.
 *
 * First the credential, as REST checks it on every request (401 when gone):
 *   - it has not expired (the JWT's `exp`, capped at an hour per ticket);
 *   - a browser session's `auth.sessions` row still exists and its user may
 *     sign in (`authSessionLive`): sign-out, a ban or a deletion ends it;
 *   - a PAT or an agent token is still valid and bound as it was
 *     (`refreshArtifactCommentActor`).
 * Then the comment routes' gate (`authorizeComments` in
 * `projects/routes/artifact-comments.ts`, read mode) over plain values:
 *   1. (the credential, above);
 *   2. the project exists, is not archived and belongs to the actor's account;
 *   3. `artifacts` and `artifact_comments` are on (else 403 `feature_disabled`);
 *   4. `project.read`, then `project.artifact.read` or
 *      `project.artifact.comment`, each intersected with an agent's grant;
 *   5. `canView`: the Artifact's sharing and its private channel.
 * A failed read throws: the caller keeps the socket and retries.
 */
import { projects, projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { PROJECT_ACTIONS } from '../iam/actions';
import { actorForServiceAccount, actorForToken, actorForUser, credentialAgentGrant, type Actor } from '../iam/actor';
import { agentMayPerform } from '../iam/agent-scope';
import { authorize } from '../iam/authorize';
import { privateChannelFoldersFor } from '../drives/service';
import { resolveUserIdentities } from '../projects/surface';
import { db } from '../shared/db';
import { authSessionLive } from '../shared/jwt-liveness';
import { ArtifactCommentAuthorityError, refreshArtifactCommentActor } from './comment-authority';
import { clipText, type LiveIdentity } from './live-rooms';
import type { ArtifactLiveTicketClaims } from './live-ticket';
import { canView, getArtifact } from './service';

export type ArtifactLiveAccess =
  | { ok: true; actor: Actor }
  | { ok: false; status: 401 | 403 | 404; error: string; code: string };

/** What the socket knows about the credential that opened it. */
export interface ArtifactLiveCredential {
  /** The browser session behind a JWT, or null. */
  authSessionId: string | null;
  /** Epoch ms after which the socket must re-authenticate (4401). */
  expiresAt: number;
}

const revoked = (): ArtifactLiveAccess => ({ ok: false, status: 401, error: 'The credential that opened this socket is no longer valid', code: 'credential_revoked' });

const notFound = (): ArtifactLiveAccess => ({ ok: false, status: 404, error: 'Artifact not found', code: 'not_found' });

/** The ticket's actor, rebuilt. `ip` is the upgrade request's client address. */
export async function artifactLiveActor(claims: ArtifactLiveTicketClaims, ip: string | null): Promise<Actor> {
  const ctx: Actor['ctx'] = { ...(ip ? { ip } : {}), ...(claims.m ? { mfaAal: claims.m } : {}) };
  if (claims.k === 'jwt') return actorForUser(claims.u, claims.c, ctx);
  if (claims.k === 'service_account') return { ...actorForServiceAccount(claims.u, claims.c), ctx };
  return actorForToken(claims.u, claims.c, claims.t, { sessionId: claims.s, ctx });
}

/** May `actor` (bound to `sessionId`, or not) view the Artifact now? */
export async function checkArtifactLiveAccess(input: {
  actor: Actor;
  sessionId: string | null;
  projectId: string;
  artifactId: string;
  credential: ArtifactLiveCredential;
}): Promise<ArtifactLiveAccess> {
  if (input.credential.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: 'The credential that opened this socket expired', code: 'credential_expired' };
  }
  const { authSessionId } = input.credential;
  if (input.actor.credential.kind === 'jwt' && authSessionId && !(await authSessionLive(input.actor.userId, authSessionId))) return revoked();
  let actor: Actor;
  try {
    actor = await refreshArtifactCommentActor(input.actor);
  } catch (error) {
    if (error instanceof ArtifactCommentAuthorityError) return revoked();
    throw error;
  }
  const [project] = await db
    .select({ accountId: projects.accountId, status: projects.status, metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project || project.status === 'archived' || project.accountId !== actor.accountId) return notFound();
  for (const flag of ['artifacts', 'artifact_comments'] as const) {
    if (!resolveFeatureFlag(project.metadata, flag)) {
      return { ok: false, status: 403, error: `${flag} is not enabled for this project`, code: 'feature_disabled' };
    }
  }
  const target = { type: 'project' as const, id: input.projectId };
  const grant = credentialAgentGrant(actor);
  const can = async (leaf: string) => agentMayPerform(grant, leaf) && (await authorize(actor, leaf, target)).allowed;
  const [member, read, comment, artifact, folders] = await Promise.all([
    authorize(actor, PROJECT_ACTIONS.PROJECT_READ, target),
    can(PROJECT_ACTIONS.PROJECT_ARTIFACT_READ),
    can(PROJECT_ACTIONS.PROJECT_ARTIFACT_COMMENT),
    getArtifact(input.projectId, input.artifactId),
    privateChannelFoldersFor(input.projectId, actor.userId, input.sessionId),
  ]);
  if (!member.allowed) return notFound();
  if (!read && !comment) return { ok: false, status: 403, error: 'You cannot view this Artifact', code: 'artifact_comment_forbidden' };
  if (!artifact || !canView(artifact, { userId: actor.userId, privateFolders: folders.visible, allPrivateFolders: folders.all })) return notFound();
  return { ok: true, actor };
}

/** The agent name of a session in this project, or null. */
export async function artifactLiveSessionAgent(projectId: string, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentName: projectSessions.agentName })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return row ? row.agentName || 'agent' : null;
}

/** How a socket shows in presence: a person by name and avatar, a session by its agent. */
export async function artifactLiveIdentity(actor: Actor, sessionId: string | null, projectId: string): Promise<LiveIdentity> {
  if (sessionId) {
    const agentName = clipText((await artifactLiveSessionAgent(projectId, sessionId)) ?? 'agent', 128);
    return { who: { kind: 'session', session_id: sessionId, agent_name: agentName }, name: agentName, avatar_url: null };
  }
  const person = (await resolveUserIdentities([actor.userId])).get(actor.userId);
  const name = clipText(person?.displayName?.trim() || person?.email || 'Member', 200);
  const avatar = person?.avatarUrl && person.avatarUrl.length <= 2048 ? person.avatarUrl : null;
  return { who: { kind: 'user', user_id: actor.userId }, name, avatar_url: avatar };
}
