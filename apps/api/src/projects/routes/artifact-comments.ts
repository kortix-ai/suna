import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayPerform, getAgentGrant } from '../../iam/agent-scope';
import { actorOf } from '../../middleware/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { privateChannelFoldersFor, sessionPrivateChannelFolder } from '../../drives/service';
import { DriveStorageError } from '../../drives/volumes';
import { canView, getArtifact, mayWrite, type Viewer } from '../../artifacts/service';
import {
  ArtifactCommentError,
  changeArtifactComment,
  createArtifactCommentThread,
  listArtifactCommentThreads,
  replyArtifactCommentThread,
  setArtifactCommentThreadStatus,
} from '../../artifacts/comments-service';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';

const ArtifactParams = z.object({ projectId: z.string().uuid(), artifactId: z.string().uuid() });
const ThreadParams = ArtifactParams.extend({ threadId: z.string().uuid() });
const CommentParams = ThreadParams.extend({ commentId: z.string().uuid() });
const Status = z.enum(['open', 'resolved']);
const Body = z.string().min(1).max(10_000).refine((value) => value.trim().length > 0 && !value.includes('\0'));
const nullableId = z.string().nullable();
const nullableDate = z.string().nullable();
const CommentSchema = z.object({
  comment_id: z.string(), thread_id: z.string(), author_user_id: nullableId, author_session_id: nullableId,
  body: z.string(), mentions: z.unknown(), marks: z.unknown(), screenshot_key: nullableId,
  created_at: z.string(), edited_at: nullableDate, deleted_at: nullableDate,
}).openapi('ArtifactComment');
const ThreadSchema = z.object({
  thread_id: z.string(), artifact_id: z.string(), project_id: z.string(), anchor: z.unknown(), anchor_version: z.string(),
  created_by_user_id: nullableId, created_by_session_id: nullableId, status: Status,
  resolved_by_user_id: nullableId, resolved_by_session_id: nullableId, resolved_at: nullableDate,
  agent_state: z.enum(['none', 'pending', 'sent', 'paused']), sent_session_id: nullableId, sent_at: nullableDate,
  created_at: z.string(), updated_at: z.string(), comments: z.array(CommentSchema), outdated: z.boolean(),
  position: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
}).openapi('ArtifactCommentThread');
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { 'application/json': { schema } } });
const responses = errors(400, 401, 403, 404, 409, 413, 429, 503);

async function authorizeComments(c: Context, projectId: string, artifactId: string, write: boolean) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, response: c.json({ error: 'Artifact not found' }, 404) };
  for (const key of ['artifacts', 'artifact_comments'] as const) {
    const disabled = requireFeatureFlag(c, loaded.row.metadata, key);
    if (disabled) return { ok: false as const, response: disabled };
  }
  const can = async (action: string) => agentMayPerform(getAgentGrant(c), action)
    && projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, action);
  const forbidden = () => ({ ok: false as const, response: c.json({ error: 'You cannot comment on this Artifact', code: 'artifact_comment_forbidden' }, 403) });
  const canComment = await can(PROJECT_ACTIONS.PROJECT_ARTIFACT_COMMENT);
  const sessionId = callerKortixSessionId(c);
  const [artifact, folders, channelFolder, projectWrite, manageAny, artifactWrite] = await Promise.all([
    getArtifact(projectId, artifactId),
    privateChannelFoldersFor(projectId, loaded.userId, sessionId),
    sessionId ? sessionPrivateChannelFolder(sessionId) : Promise.resolve(null),
    can(PROJECT_ACTIONS.PROJECT_WRITE),
    can(PROJECT_ACTIONS.PROJECT_ARTIFACT_MANAGE),
    can(PROJECT_ACTIONS.PROJECT_ARTIFACT_WRITE),
  ]);
  const viewer: Viewer = {
    userId: loaded.userId, privateFolders: folders.visible, allPrivateFolders: folders.all,
    channelFolder, projectWrite, manageAny,
  };
  if (!artifact || !canView(artifact, viewer)) return { ok: false as const, response: c.json({ error: 'Artifact not found' }, 404) };
  if (!(await can(PROJECT_ACTIONS.PROJECT_ARTIFACT_READ)) && !canComment) return forbidden();
  if (write && !canComment) return forbidden();
  const canEdit = artifactWrite && await mayWrite(artifact, viewer);
  return { ok: true as const, actor: await actorOf(c, loaded.row.accountId), scope: { artifact, viewer, sessionId, canEdit } };
}

function failure(c: Context, error: unknown) {
  if (error instanceof ArtifactCommentError || error instanceof DriveStorageError) {
    if (error instanceof ArtifactCommentError && error.status === 429) c.header('Retry-After', String(error.retryAfterSeconds));
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  throw error;
}

export function registerArtifactCommentRoutes(): void {
  projectsApp.use('/:projectId/artifacts/:artifactId/comments*', bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'A comment request cannot exceed 64 KiB', code: 'comment_too_large' }, 413),
  }));

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/comments', tags: ['artifacts'],
    summary: 'Read comment threads on an Artifact', ...auth,
    request: { params: ArtifactParams, query: z.object({ status: z.enum(['open', 'resolved', 'all']).optional() }) },
    responses: { 200: json(z.object({ threads: z.array(ThreadSchema) }), 'The threads and comments'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, false);
    if (!access.ok) return access.response;
    try {
      return c.json({ threads: await listArtifactCommentThreads(access.scope, c.req.valid('query').status ?? 'open') }, 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/comments', tags: ['artifacts'],
    summary: 'Open an anchored comment thread', ...auth,
    request: { params: ArtifactParams, body: body(z.object({ anchor: z.unknown(), body: Body })) },
    responses: { 201: json(z.object({ thread: ThreadSchema }), 'The new thread'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ thread: await createArtifactCommentThread(access.actor, access.scope, c.req.valid('json')) }, 201);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/comments/{threadId}/replies', tags: ['artifacts'],
    summary: 'Reply in a comment thread', ...auth,
    request: { params: ThreadParams, body: body(z.object({ body: Body })) },
    responses: { 201: json(z.object({ comment: CommentSchema }), 'The new reply'), ...responses },
  }), async (c) => {
    const { projectId, artifactId, threadId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ comment: await replyArtifactCommentThread(access.actor, access.scope, threadId, c.req.valid('json').body) }, 201);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/artifacts/{artifactId}/comments/{threadId}', tags: ['artifacts'],
    summary: 'Resolve or reopen a comment thread', ...auth,
    request: { params: ThreadParams, body: body(z.object({ status: Status })) },
    responses: { 200: json(z.object({ thread: ThreadSchema }), 'The updated thread'), ...responses },
  }), async (c) => {
    const { projectId, artifactId, threadId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ thread: await setArtifactCommentThreadStatus(access.actor, access.scope, threadId, c.req.valid('json').status) }, 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/artifacts/{artifactId}/comments/{threadId}/{commentId}', tags: ['artifacts'],
    summary: 'Edit your own comment', ...auth,
    request: { params: CommentParams, body: body(z.object({ body: Body })) },
    responses: { 200: json(z.object({ comment: CommentSchema }), 'The edited comment'), ...responses },
  }), async (c) => {
    const { projectId, artifactId, threadId, commentId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ comment: await changeArtifactComment(access.actor, access.scope, threadId, commentId, c.req.valid('json').body) }, 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/artifacts/{artifactId}/comments/{threadId}/{commentId}', tags: ['artifacts'],
    summary: 'Delete your own comment, or any comment as a manager', ...auth,
    request: { params: CommentParams },
    responses: { 200: json(z.object({ comment: CommentSchema }), 'The deleted comment'), ...responses },
  }), async (c) => {
    const { projectId, artifactId, threadId, commentId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ comment: await changeArtifactComment(access.actor, access.scope, threadId, commentId, null) }, 200);
    } catch (error) { return failure(c, error); }
  });
}
