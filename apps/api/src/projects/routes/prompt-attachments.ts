import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  beginPromptAttachment,
  completePromptAttachment,
  deletePromptAttachment,
  readPromptAttachmentChunk,
  resolveRuntimePromptAttachmentDescriptor,
  uploadPromptAttachmentChunk,
} from '../prompt-attachments';

const metadata = z.object({
  attachment_id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  expires_at: z.string(),
});
const scopeParams = z.object({ projectId: z.string().uuid(), attachmentId: z.string().uuid() });
const descriptor = z.object({
  version: z.literal(1),
  command_id: z.string().uuid(),
  attachment_id: z.string().uuid(),
  part_index: z.number().int().nonnegative(),
  filename: z.string(),
  mime: z.string(),
  size_bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  target_path: z.string(),
  download_url: z.string().url(),
  download_expires_at: z.string(),
});
async function scope(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return null;
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_SESSION_START,
  );
  return { accountId: loaded.row.accountId, projectId, userId: loaded.userId };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/runtime/prompt-attachments/{attachmentId}',
    tags: ['sessions'],
    summary: 'Resolve one running command attachment for its session sandbox',
    ...auth,
    request: {
      params: scopeParams,
      query: z.object({
        command_id: z.string().uuid(),
        part_index: z.string().regex(/^\d{1,3}$/),
      }),
    },
    responses: {
      200: json(descriptor, 'Short-lived runtime attachment descriptor'),
      ...errors(400, 401, 403, 404, 409, 503),
    },
  }),
  async (c) => {
    if (!isSessionSandboxCredential(c)) {
      return c.json({ error: 'runtime attachment descriptor requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    const sandboxId = c.get('sandboxId');
    if (!accountId || !sandboxId) {
      return c.json({ error: 'runtime attachment descriptor requires a sandbox token' }, 403);
    }
    const { projectId, attachmentId } = c.req.valid('param');
    const query = c.req.valid('query');
    const result = await resolveRuntimePromptAttachmentDescriptor({
      accountId,
      sandboxId,
      projectId,
      attachmentId,
      commandId: query.command_id,
      partIndex: Number(query.part_index),
    });
    c.header('Cache-Control', 'no-store');
    return c.json(result, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/attachments',
    tags: ['sessions'],
    summary: 'Begin a private prompt attachment upload',
    ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              filename: z.string().min(1).max(1024),
              mime: z.string().max(255),
              size: z.number(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(metadata.extend({ chunk_size: z.number() }), 'Upload handle'),
      ...errors(400, 401, 403, 404, 413),
    },
  }),
  async (c) => {
    const owner = await scope(c);
    if (!owner) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
    return c.json(await beginPromptAttachment(owner, body), 201);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/attachments/{attachmentId}/chunks/{index}',
    tags: ['sessions'],
    summary: 'Upload one ordered attachment chunk (64 KiB maximum)',
    ...auth,
    request: {
      params: scopeParams.extend({ index: z.string().regex(/^\d{1,4}$/) }),
      body: {
        content: {
          'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
    },
    responses: {
      200: json(z.object({ received_bytes: z.number(), size: z.number() }), 'Durably stored chunk'),
      ...errors(400, 401, 403, 404, 409, 413, 503),
    },
  }),
  async (c) => {
    const owner = await scope(c);
    if (!owner) return c.json({ error: 'Not found' }, 404);
    const { attachmentId, index } = c.req.valid('param');
    return c.json(
      await uploadPromptAttachmentChunk(
        owner,
        attachmentId,
        Number(index),
        await readPromptAttachmentChunk(c.req.raw),
      ),
      200,
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/attachments/{attachmentId}/complete',
    tags: ['sessions'],
    summary: 'Finalize and verify a private prompt attachment',
    ...auth,
    request: { params: scopeParams },
    responses: { 200: json(metadata, 'Ready attachment'), ...errors(400, 401, 403, 404, 409, 503) },
  }),
  async (c) => {
    const owner = await scope(c);
    if (!owner) return c.json({ error: 'Not found' }, 404);
    return c.json(await completePromptAttachment(owner, c.req.valid('param').attachmentId), 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/attachments/{attachmentId}',
    tags: ['sessions'],
    summary: 'Remove an unsubmitted prompt attachment',
    ...auth,
    request: { params: scopeParams },
    responses: {
      204: { description: 'Attachment removed' },
      ...errors(400, 401, 403, 404, 409, 503),
    },
  }),
  async (c) => {
    const owner = await scope(c);
    if (!owner) return c.json({ error: 'Not found' }, 404);
    await deletePromptAttachment(owner, c.req.valid('param').attachmentId);
    return c.body(null, 204);
  },
);
