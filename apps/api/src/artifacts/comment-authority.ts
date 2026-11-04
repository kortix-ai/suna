import { artifactComments, artifactCommentThreads, artifacts, jobQueue, projects, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { privateChannelFoldersFor } from '../drives/service';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { PROJECT_ACTIONS } from '../iam/actions';
import { actingPrincipal, loadTokenBinding, tokenCredential, type Actor } from '../iam/actor';
import { authorize } from '../iam/authorize';
import { mayPromptSessions } from '../notifications/access';
import { loadVisibleSession, resolveAndAuthorizeAgentAs, sessionIsTombstoned, type CreateSessionCommand } from '../projects/surface';
import { validateAccountTokenById } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { canView, type ArtifactRow } from './service';
import { artifactCommentOriginIsCurrent } from './comment-mentions';
import type { ArtifactCommentAgentPayload } from './comment-delivery';

type ProjectRow = typeof projects.$inferSelect;
type ProjectSessionRow = typeof projectSessions.$inferSelect;

export class ArtifactCommentAuthorityError extends Error {
  readonly status = 403;
  readonly code = 'artifact_comment_agent_forbidden';
  constructor() { super('You cannot send these Artifact comments to this agent'); this.name = 'ArtifactCommentAuthorityError'; }
}

interface CurrentAuthority { actor: Actor; callerSessionId: string | null; onBehalfOf: string | null | undefined }
const denied = () => new ArtifactCommentAuthorityError();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function currentAuthority(original: Actor): Promise<CurrentAuthority> {
  if (!original || !isUuid(original.userId) || !isUuid(original.accountId) || !record(original.credential) || !record(original.ctx)) throw denied();
  const credential = original.credential;
  if (credential.kind === 'sandbox') throw denied();
  if (credential.kind === 'jwt' || credential.kind === 'service_account') {
    return { actor: original, callerSessionId: null, onBehalfOf: undefined };
  }
  if ((credential.kind !== 'pat' && credential.kind !== 'agent_session') || !isUuid(credential.tokenId)) throw denied();
  const checked = await validateAccountTokenById(credential.tokenId);
  if (!checked.isValid) {
    if (checked.credentialDead) throw denied();
    throw new Error('Artifact comment credential validation is unavailable');
  }
  if (checked.accountId !== original.accountId || checked.userId !== original.userId
    || (checked.projectId ?? null) !== credential.projectId
    || (credential.kind === 'agent_session' && ((checked.sessionId ?? null) !== credential.sessionId || checked.serviceAccountId !== credential.serviceAccountId))) throw denied();
  loadTokenBinding.invalidate(credential.tokenId);
  const fresh = await tokenCredential(credential.tokenId, checked.accountId, checked.sessionId ?? null, {
    projectId: checked.projectId ?? null,
    agentGrant: checked.agentGrant ?? null,
    serviceAccountId: checked.serviceAccountId ?? null,
    onBehalfOfUserId: checked.onBehalfOfUserId ?? null,
  });
  return { actor: { ...original, credential: fresh }, callerSessionId: checked.sessionId ?? null, onBehalfOf: checked.onBehalfOfUserId ?? null };
}

export async function refreshArtifactCommentActor(original: Actor): Promise<Actor> {
  return (await currentAuthority(original)).actor;
}

export async function assertArtifactCommentDeliveryAccess(actor: Actor, artifact: ArtifactRow, callerSessionId: string | null): Promise<void> {
  if (actor.accountId !== artifact.accountId || !(await authorize(actor, PROJECT_ACTIONS.PROJECT_ARTIFACT_COMMENT, { type: 'project', id: artifact.projectId })).allowed) throw denied();
  const folders = await privateChannelFoldersFor(artifact.projectId, actor.userId, callerSessionId);
  if (!canView(artifact, { userId: actor.userId, privateFolders: folders.visible, allPrivateFolders: folders.all })) throw denied();
}

export async function authorizeArtifactCommentAgent(
  original: Actor, project: ProjectRow, agentName: string, session?: ProjectSessionRow,
): Promise<{ actor: Actor; agentName: string; canPromptExisting: boolean; callerSessionId: string | null }> {
  const current = await currentAuthority(original);
  const { actor, callerSessionId, onBehalfOf } = current;
  if (actor.accountId !== project.accountId || project.status === 'archived' || !agentName.trim()) throw denied();
  const target = { type: 'project' as const, id: project.projectId };
  const rights = await Promise.all([
    authorize(actor, PROJECT_ACTIONS.PROJECT_SESSION_START, target),
    authorize(actor, PROJECT_ACTIONS.PROJECT_ARTIFACT_COMMENT, target),
  ]);
  if (rights.some((right) => !right.allowed)) throw denied();
  const loaded = { row: project, userId: actor.userId, actor };
  let existing = false;
  if (session && session.accountId === project.accountId && session.projectId === project.projectId && session.agentName === agentName) {
    const visible = await loadVisibleSession(loaded, session.sessionId, callerSessionId, callerSessionId);
    existing = !!visible && !sessionIsTombstoned(visible.row);
    if (existing && actingPrincipal(actor).type === 'user') existing = (await mayPromptSessions(actor.userId, actor.accountId, [session.sessionId])).has(session.sessionId);
  }
  try {
    await resolveAndAuthorizeAgentAs(actor, onBehalfOf, loaded, project.projectId, agentName, undefined,
      PROJECT_ACTIONS.PROJECT_SESSION_START, existing ? session!.spaceId : undefined);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) throw denied();
    throw error;
  }
  return { actor, agentName, canPromptExisting: existing, callerSessionId };
}

interface DeliveryScope {
  accountId: string;
  projectId: string;
  artifactId: string | null | undefined;
  sessionId: string;
  userId: string | null;
  agentName?: string;
  idempotencyKey?: string | null;
  pendingFirst?: boolean;
}

async function revalidateDelivery(reference: unknown, scope: DeliveryScope, creating: boolean) {
  if (!record(reference) || typeof reference.job_id !== 'string' || !isUuid(reference.job_id)
    || typeof reference.target_key !== 'string' || !scope.sessionId || (creating && !isUuid(scope.sessionId))) throw denied();
  const [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.jobId, reference.job_id), eq(jobQueue.queue, 'artifact-comment-agents'))).limit(1);
  const payload = job?.payload;
  if (!job || (creating ? job.status !== 'queued' : !['queued', 'done', 'dead'].includes(job.status)) || !record(payload) || !record(payload.actor) || !Array.isArray(payload.targets)
    || typeof payload.artifactId !== 'string' || payload.artifactId !== scope.artifactId || job.artifactId !== payload.artifactId || !isUuid(payload.artifactId)
    || !Array.isArray(payload.threadIds) || !payload.threadIds.length
    || payload.threadIds.some((id) => typeof id !== 'string' || !isUuid(id))) throw denied();
  const targets = payload.targets.filter((target) => record(target) && target.key === reference.target_key);
  if (targets.length !== 1) throw denied();
  const target = targets[0] as Record<string, unknown>;
  const initial = !creating && scope.pendingFirst === true && target.created === true;
  const sent = !creating && target.status === 'sent';
  if (job.status === 'dead' && !sent) throw denied();
  if ((creating ? target.created !== true || target.status !== 'pending' : !['sent', ...(initial ? ['pending'] : [])].includes(String(target.status))) || target.sessionId !== scope.sessionId
    || typeof target.agentName !== 'string' || (creating && target.agentName !== scope.agentName) || typeof target.recipientKey !== 'string'
    || typeof target.implicit !== 'boolean' || (creating && scope.idempotencyKey !== (target.createKey ?? target.key))) throw denied();
  const original = payload.actor as unknown as Actor;
  if (original.userId !== scope.userId || original.accountId !== scope.accountId) throw denied();
  const [source] = await db.select({ artifact: artifacts, project: projects }).from(artifacts)
    .innerJoin(projects, and(eq(projects.projectId, artifacts.projectId), eq(projects.accountId, artifacts.accountId)))
    .where(and(eq(artifacts.artifactId, payload.artifactId), eq(artifacts.projectId, scope.projectId), eq(artifacts.accountId, original.accountId))).limit(1);
  if (!source || !resolveFeatureFlag(source.project.metadata, 'artifacts') || !resolveFeatureFlag(source.project.metadata, 'artifact_comments')) throw denied();
  const threadIds = [...new Set(payload.threadIds as string[])];
  const threads = await db.select().from(artifactCommentThreads).where(and(eq(artifactCommentThreads.artifactId, source.artifact.artifactId),
    eq(artifactCommentThreads.projectId, source.project.projectId), inArray(artifactCommentThreads.threadId, threadIds)));
  if (threads.length !== threadIds.length || threads.some((thread) => thread.agentState === 'paused' && (!sent || !thread.agentError))) throw denied();
  const roots = await db.selectDistinctOn([artifactComments.threadId], { threadId: artifactComments.threadId, deletedAt: artifactComments.deletedAt })
    .from(artifactComments).where(inArray(artifactComments.threadId, threadIds))
    .orderBy(asc(artifactComments.threadId), asc(artifactComments.createdAt), asc(artifactComments.commentId));
  if (roots.length !== threadIds.length || roots.some((root) => root.deletedAt !== null)) throw denied();
  if (target.originCommentId !== undefined && (typeof target.originCommentId !== 'string' || !isUuid(target.originCommentId)
    || !(await artifactCommentOriginIsCurrent(source.artifact, threadIds, { recipientKey: target.recipientKey, originCommentId: target.originCommentId })))) throw denied();
  let sourceComment: typeof artifactComments.$inferSelect | undefined;
  if (payload.commentId !== undefined) {
    if (typeof payload.commentId !== 'string' || !isUuid(payload.commentId)) throw denied();
    const [comment] = await db.select().from(artifactComments).where(and(eq(artifactComments.commentId, payload.commentId), inArray(artifactComments.threadId, threadIds))).limit(1);
    if (!comment || comment.deletedAt) throw denied();
    if (!target.implicit && (!Array.isArray(comment.mentions) || !comment.mentions.some((mention) =>
      (mention.kind === 'session' && `session:${mention.session_id}` === target.recipientKey)
      || (mention.kind === 'agent' && `agent:${mention.agent_name}` === target.recipientKey)))) throw denied();
    sourceComment = comment;
  }
  const [session] = creating ? [] : await db.select().from(projectSessions).where(and(eq(projectSessions.sessionId, scope.sessionId),
    eq(projectSessions.projectId, scope.projectId), eq(projectSessions.accountId, scope.accountId))).limit(1);
  if (!creating && !session) throw denied();
  const authorized = await authorizeArtifactCommentAgent(original, source.project, target.agentName, initial ? undefined : session);
  if (authorized.callerSessionId !== payload.callerSessionId) throw denied();
  if (!creating && !initial && !authorized.canPromptExisting) throw denied();
  if (sourceComment && (sourceComment.authorSessionId
    ? sourceComment.authorSessionId !== authorized.callerSessionId
    : sourceComment.authorUserId !== authorized.actor.userId)) throw denied();
  await assertArtifactCommentDeliveryAccess(authorized.actor, source.artifact, authorized.callerSessionId);
  return { actor: authorized.actor, callerSessionId: authorized.callerSessionId, payload: payload as ArtifactCommentAgentPayload };
}

export async function revalidateArtifactCommentCreate(command: CreateSessionCommand): Promise<{ actor: Actor; callerSessionId: string | null }> {
  if (command.source !== 'system:artifact-comment' || typeof command.body.session_id !== 'string' || typeof command.body.agent_name !== 'string') throw denied();
  return revalidateDelivery(command.metadata?.artifactCommentDelivery, {
    accountId: command.project.accountId, projectId: command.project.projectId, artifactId: command.artifactId,
    sessionId: command.body.session_id, userId: command.userId, agentName: command.body.agent_name, idempotencyKey: command.idempotencyKey,
  }, true);
}

export async function revalidateArtifactCommentContinue(
  row: Pick<typeof sessionLifecycleCommands.$inferSelect, 'accountId' | 'projectId' | 'sessionId' | 'artifactId' | 'actorUserId' | 'idempotencyKey'>,
  reference: unknown,
): Promise<{ actor: Actor; callerSessionId: string | null; payload: ArtifactCommentAgentPayload }> {
  if (!row.sessionId) throw denied();
  return revalidateDelivery(reference, { accountId: row.accountId, projectId: row.projectId, artifactId: row.artifactId,
    sessionId: row.sessionId, userId: row.actorUserId, pendingFirst: row.idempotencyKey === `prompt:${row.sessionId}:pending-first` }, false);
}
