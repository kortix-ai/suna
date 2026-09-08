import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  beginPromptAttachment,
  completePromptAttachment,
  deletePromptAttachment,
  readPromptAttachmentChunk,
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
