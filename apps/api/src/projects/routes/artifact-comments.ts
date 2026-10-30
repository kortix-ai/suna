import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { ArtifactCommentScreenshotError } from '../../artifacts/comment-screenshot-validation';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayPerform, getAgentGrant } from '../../iam/agent-scope';
import { actorOf } from '../../middleware/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { privateChannelFoldersFor, sessionPrivateChannelFolder } from '../../drives/service';
import { DriveStorageError } from '../../drives/volumes';
import { ArtifactError, canView, getArtifact, mayWrite, type Viewer } from '../../artifacts/service';
import { readArtifactCommentContext } from '../../artifacts/comment-context';
import { ARTIFACT_COMMENT_SEND_LIMIT } from '../../artifacts/comment-routing-context';
import { readArtifactActivity } from '../../artifacts/activity-service';
import { ArtifactActivityQueryError } from '../../artifacts/activity-query';
import { ArtifactCommentDeliveryError, sendArtifactCommentThreads } from '../../artifacts/comment-delivery';
import {
  ArtifactCommentError,
  artifactIdForCommentThread,
  changeArtifactComment,
  createArtifactCommentThread,
  getArtifactCommentThread,
  listArtifactCommentThreads,
  replyArtifactCommentThread,
  setArtifactCommentThreadStatus,
} from '../../artifacts/comments-service';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';

const ArtifactParams = z.object({ projectId: z.string().uuid(), artifactId: z.string().uuid() });
const ThreadParams = ArtifactParams.extend({ threadId: z.string().uuid() });
const CommentParams = ThreadParams.extend({ commentId: z.string().uuid() });
const ThreadLookupParams = z.object({ projectId: z.string().uuid(), threadId: z.string().uuid() });
const Status = z.enum(['open', 'resolved']);
const Version = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const Body = z.string().min(1).max(10_000).refine((value) => value.trim().length > 0 && !value.includes('\0'));
const nullableId = z.string().nullable();
const nullableDate = z.string().nullable();
const CommentSchema = z.object({
  comment_id: z.string(), thread_id: z.string(), author_user_id: nullableId, author_session_id: nullableId,
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), user_id: z.string(), name: z.string() }),
    z.object({ kind: z.literal('session'), session_id: z.string(), agent_name: z.string(), title: z.string().nullable() }),
  ]),
  can_edit: z.boolean(), can_delete: z.boolean(),
  body: z.string(), mentions: z.unknown(), marks: z.unknown(), screenshot_key: nullableId, screenshot_url: z.string().optional(),
  created_at: z.string(), edited_at: nullableDate, deleted_at: nullableDate,
}).openapi('ArtifactComment');
const ThreadSchema = z.object({
  can_reply: z.boolean(), can_resolve: z.boolean(),
  thread_id: z.string(), artifact_id: z.string(), project_id: z.string(), anchor: z.unknown(), anchor_version: z.string(),
  created_by_user_id: nullableId, created_by_session_id: nullableId, status: Status,
  resolved_by_user_id: nullableId, resolved_by_session_id: nullableId, resolved_at: nullableDate,
  agent_state: z.enum(['none', 'pending', 'sent', 'paused']), agent_error: z.string().nullable(), sent_session_id: nullableId, sent_at: nullableDate,
  created_at: z.string(), updated_at: z.string(), comments: z.array(CommentSchema), outdated: z.boolean(),
  position: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
}).openapi('ArtifactCommentThread');
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { 'application/json': { schema } } });
const responses = errors(400, 401, 403, 404, 409, 413, 429, 503);

async function authorizeComments(c: Context, projectId: string, target: string | { threadId: string }, write: boolean) {
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
  const artifactId = typeof target === 'string' ? target : await artifactIdForCommentThread(projectId, target.threadId);
  const [artifact, folders, channelFolder, projectWrite, manageAny, artifactWrite] = await Promise.all([
    artifactId ? getArtifact(projectId, artifactId) : Promise.resolve(null),
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
  return { ok: true as const, actor: await actorOf(c, loaded.row.accountId), scope: { artifact, viewer, sessionId, canEdit, canComment } };
}

function failure(c: Context, error: unknown) {
  if (error instanceof ArtifactError || error instanceof ArtifactCommentError || error instanceof ArtifactCommentDeliveryError || error instanceof ArtifactActivityQueryError || error instanceof DriveStorageError || error instanceof ArtifactCommentScreenshotError) {
    if (error instanceof ArtifactCommentError && error.status === 429) c.header('Retry-After', String(error.retryAfterSeconds));
    return c.json({ error: error.message, code: error.code, ...(error instanceof ArtifactCommentScreenshotError && error.limits ? { limits: error.limits } : {}) }, error.status);
  }
  if (error instanceof Error && error.name === 'ArtifactCommentAuthorityError') return c.json({ error: 'You cannot send Artifact comments to that agent', code: 'artifact_comment_agent_forbidden' }, 403);
  throw error;
}

export function registerArtifactCommentRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifact-comment-threads/{threadId}', tags: ['artifacts'],
    summary: 'Read a visible Artifact comment thread by its project-scoped id', ...auth,
    request: { params: ThreadLookupParams },
    responses: { 200: json(z.object({ thread: ThreadSchema }), 'The thread and comments'), ...responses },
  }), async (c) => {
    const { projectId, threadId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, { threadId }, false);
    if (!access.ok) return access.response;
    try {
      return c.json({ thread: await getArtifactCommentThread(access.scope, threadId) }, 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/activity', tags: ['artifacts'],
    summary: 'Read Artifact activity and saves from Files history', ...auth,
    request: { params: ArtifactParams, query: z.object({ limit: z.string().optional(), cursor: z.string().optional() }) },
    responses: { 200: json(z.object({
      items: z.array(z.object({ id: z.string(), type: z.string(), at: z.string(), data: z.record(z.unknown()),
        actor: z.object({ kind: z.enum(['user', 'session', 'system']), id: nullableId, name: z.string() }),
      })), next_cursor: nullableId, older_versions: z.boolean(),
    }), 'The activity page'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, false);
    if (!access.ok) return access.response;
    try {
      return c.json(await readArtifactActivity(access.scope.artifact, c.req.valid('query')), 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.use('/:projectId/artifacts/:artifactId/comments*', async (c, next) => {
    const imageBody = c.req.method === 'POST' && (c.req.path.endsWith('/comments') || c.req.path.endsWith('/replies'));
    return bodyLimit({
      maxSize: imageBody ? 4 * 1024 * 1024 : 64 * 1024,
      onError: (context) => context.json({ error: 'Comment request is too large', code: imageBody ? 'screenshot_too_large' : 'comment_too_large' }, 413),
    })(c, async () => {
      if (imageBody) {
        const text = await c.req.text();
        if (Buffer.byteLength(text) > 64 * 1024) {
          let input: Record<string, unknown> | null = null;
          try { input = JSON.parse(text); } catch { }
          if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'marks') && !Object.hasOwn(input, 'screenshot_base64')) {
            c.res = c.json({ error: 'A text comment request cannot exceed 64 KiB', code: 'comment_too_large' }, 413);
            return;
          }
        }
      }
      await next();
    });
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/comments/context', tags: ['artifacts'],
    summary: 'Read comment permissions, accepted mention tokens and the proposed Send target', ...auth,
    request: { params: ArtifactParams, query: z.object({ version: Version.optional(), agent: z.string().min(1).max(128).optional() }) },
    responses: { 200: json(z.object({
      can_comment: z.boolean(), can_moderate: z.boolean(), comment_count: z.number().int(),
      people: z.array(z.object({ user_id: z.string(), name: z.string(), avatar_url: nullableId, token: z.string() })),
      agents: z.array(z.object({ agent_name: z.string(), name: z.string(), session_id: nullableId, token: z.string() })),
      send_target: z.object({ kind: z.enum(['session', 'new']), session_id: nullableId, agent_name: z.string() }).nullable(),
      send_thread_ids: z.array(z.string()).max(ARTIFACT_COMMENT_SEND_LIMIT), send_thread_count: z.number().int().nonnegative(), version: z.object({ commit_id: nullableId, entry_version: nullableId }),
    }), 'The current or historical comment context'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, false);
    if (!access.ok) return access.response;
    try { return c.json(await readArtifactCommentContext(access.scope, access.actor, c.req.valid('query')), 200); }
    catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/comments/send', tags: ['artifacts'],
    summary: 'Send selected Artifact comment threads to an agent', ...auth,
    request: { params: ArtifactParams, body: body(z.object({ thread_ids: z.array(z.string().uuid()).min(1).max(ARTIFACT_COMMENT_SEND_LIMIT), batch_id: z.string().uuid().optional(), agent: z.string().min(1).max(128).optional() })) },
    responses: { 200: json(z.object({ session_id: z.string(), created: z.boolean() }), 'The selected or reserved agent session'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json(await sendArtifactCommentThreads(access.scope.artifact, access.actor, access.scope.sessionId, c.req.valid('json')), 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/comments', tags: ['artifacts'],
    summary: 'Read comment threads on an Artifact', ...auth,
    request: { params: ArtifactParams, query: z.object({ status: z.enum(['open', 'resolved', 'all']).optional(), version: Version.optional() }) },
    responses: { 200: json(z.object({ threads: z.array(ThreadSchema) }), 'The threads and comments'), ...responses },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, false);
    if (!access.ok) return access.response;
    try {
      return c.json({ threads: await listArtifactCommentThreads(access.scope, c.req.valid('query').status ?? 'open', c.req.valid('query').version) }, 200);
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/comments/{commentId}/screenshot', tags: ['artifacts'],
    summary: 'Read a screenshot with current Artifact view access', ...auth,
    request: { params: ArtifactParams.extend({ commentId: z.string().uuid() }) },
    responses: { 200: { description: 'The private PNG or WebP bytes', content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) }, 'image/webp': { schema: z.string().openapi({ format: 'binary' }) } } }, ...responses },
  }), async (c) => {
    const { projectId, artifactId, commentId } = c.req.valid('param');
    const notFound = () => c.json({ error: 'Screenshot not found', code: 'screenshot_not_found' }, 404);
    let access;
    try { access = await authorizeComments(c, projectId, artifactId, false); }
    catch (error) { if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) return notFound(); throw error; }
    if (!access.ok) {
      if (access.response.status === 403 && (await access.response.clone().json() as { code?: string }).code === 'feature_disabled') return access.response;
      return notFound();
    }
    try {
      const { readArtifactCommentScreenshot } = await import('../../artifacts/comment-screenshot-read');
      const image = await readArtifactCommentScreenshot(access.scope, commentId);
      return new Response(new Uint8Array(image.bytes), { headers: {
        'Content-Type': image.mime, 'Content-Length': String(image.bytes.byteLength),
        'Cache-Control': 'private, no-store', 'Vary': 'Authorization', 'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) { return failure(c, error); }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/comments', tags: ['artifacts'],
    summary: 'Open an anchored comment thread', ...auth,
    request: { params: ArtifactParams, body: body(z.object({ anchor: z.unknown(), body: Body, marks: z.unknown().optional(), screenshot_base64: z.unknown().optional() })) },
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
    request: { params: ThreadParams, body: body(z.object({ body: Body, marks: z.unknown().optional(), screenshot_base64: z.unknown().optional() })) },
    responses: { 201: json(z.object({ comment: CommentSchema }), 'The new reply'), ...responses },
  }), async (c) => {
    const { projectId, artifactId, threadId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, true);
    if (!access.ok) return access.response;
    try {
      return c.json({ comment: await replyArtifactCommentThread(access.actor, access.scope, threadId, c.req.valid('json')) }, 201);
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
