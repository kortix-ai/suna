import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../iam';
import { auth, errors, json } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { inspectDatabaseError } from '../shared/database-errors';
import { logger } from '../lib/logger';
import { assertProjectCapability, loadProjectForUser, projectsApp } from '../projects/surface';
import { requireFeatureFlag } from '../feature-flags/gate';
import { resolveSessionSandboxRegion } from '../platform/services/sandbox-region';
import type { AppEnv } from '../types';
import { resolveAppViewerIdentity } from '../apps/viewer';
import {
  BackendLimitError,
  type BackendRow,
  backendAdminKey,
  backendMemberToken,
  deleteBackend,
  effectiveStatus,
  getLiveBackend,
  insertBackend,
  listProjectBackends,
  provisionBackend,
} from './provision';

const STATUSES = ['provisioning', 'running', 'error', 'deleted'] as const;

const BackendObject = z
  .object({
    backend_id: z.string().uuid(),
    project_id: z.string().uuid(),
    name: z.string(),
    status: z.enum(STATUSES),
    url: z.string().nullable().openapi({ description: 'Convex client URL (CONVEX_URL).' }),
    site_url: z.string().nullable().openapi({ description: 'Convex HTTP actions URL.' }),
    cpu: z.number().int(),
    memory_gb: z.number().int(),
    disk_gb: z.number().int(),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Backend');

const BackendCredentials = z
  .object({
    url: z.string(),
    site_url: z.string(),
    admin_key: z.string(),
    env: z.record(z.string(), z.string()).openapi({
      description: 'Ready-to-use variables for the Convex CLI against this backend.',
    }),
  })
  .openapi('BackendCredentials');

const BackendToken = z
  .object({
    token: z.string().openapi({ description: 'ES256 JWT the backend accepts as `ctx.auth`. Send it with `client.setAuth`.' }),
    expires_at: z.string(),
  })
  .openapi('BackendToken');

const NameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, starting with a letter');

const ProjectParams = z.object({ projectId: z.string().uuid() });
const BackendParams = z.object({ projectId: z.string().uuid(), backendId: z.string().uuid() });

function serialize(row: BackendRow) {
  const status = effectiveStatus(row) as (typeof STATUSES)[number];
  const lastError =
    status !== row.status
      ? 'Provisioning was interrupted. Delete this backend and create it again.'
      : (row.metadata as { lastError?: unknown }).lastError;
  return {
    backend_id: row.backendId,
    project_id: row.projectId,
    name: row.name,
    status,
    url: row.url,
    site_url: row.siteUrl,
    cpu: row.cpu,
    memory_gb: row.memoryGb,
    disk_gb: row.diskGb,
    error: status === 'error' && typeof lastError === 'string' ? lastError : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Membership, then capability, then the `backends` flag — the Apps order
 * (apps/routes.ts). Returns the loaded project, or the Response to answer.
 */
async function authorizedProject(c: Context<AppEnv>, projectId: string, write = false) {
  const loaded = await loadProjectForUser(c, projectId, write ? 'write' : 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    write ? PROJECT_ACTIONS.PROJECT_BACKEND_WRITE : PROJECT_ACTIONS.PROJECT_BACKEND_READ,
  );
  return requireFeatureFlag(c, loaded.row.metadata, 'backends') ?? loaded;
}

export function registerBackendsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends', tags: ['backends'], summary: 'List backends', ...auth,
      request: { params: ProjectParams },
      responses: { 200: json(z.object({ backends: z.array(BackendObject) }), 'Backends'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const rows = await listProjectBackends(projectId);
      return c.json({ backends: rows.map(serialize) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends', tags: ['backends'], summary: 'Create a backend', ...auth,
      description:
        'Claims the name and starts provisioning a self-hosted Convex backend in its own machine. ' +
        'Answers 202 with status `provisioning`; poll the backend until it is `running` or `error`. ' +
        'Usually a few seconds; the first create in a region also builds the image.',
      request: {
        params: ProjectParams,
        body: { content: { 'application/json': { schema: z.object({ name: NameSchema }) } }, required: true },
      },
      responses: {
        202: json(z.object({ backend: BackendObject }), 'Provisioning'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const { name } = c.req.valid('json');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      let row: BackendRow;
      try {
        row = await insertBackend({ projectId, accountId: loaded.row.accountId, userId: loaded.userId, name });
      } catch (error) {
        if (error instanceof BackendLimitError) {
          return c.json({ error: error.message, code: 'backend_limit' }, 409);
        }
        if (inspectDatabaseError(error)?.pgCode === '23505') {
          return c.json({ error: `a backend named "${name}" already exists`, code: 'backend_name_taken' }, 409);
        }
        throw error;
      }
      // Outlives the response; a failure lands on the row as status `error`.
      void provisionBackend(row, resolveSessionSandboxRegion(loaded.row.metadata)).catch((error) =>
        logger.error('[backends] provision failed', { projectId, backendId: row.backendId, error: String(error) }),
      );
      return c.json({ backend: serialize(row) }, 202);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}', tags: ['backends'], summary: 'Get a backend', ...auth,
      request: { params: BackendParams },
      responses: { 200: json(z.object({ backend: BackendObject }), 'Backend'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      return c.json({ backend: serialize(row) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}/credentials', tags: ['backends'],
      summary: 'Get backend admin credentials', ...auth,
      description: 'The admin key controls the backend\'s code and data. Every read is audited.',
      request: { params: BackendParams },
      responses: { 200: json(BackendCredentials, 'Credentials'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const { url, siteUrl, adminKeyEnc } = row;
      if (row.status !== 'running' || !url || !siteUrl || !adminKeyEnc) {
        return c.json({ error: `backend is ${effectiveStatus(row)}`, code: 'backend_not_running' }, 409);
      }
      const adminKey = backendAdminKey({ ...row, adminKeyEnc });
      await recordAuditEvent({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: loaded.userId,
        action: 'backend.credentials.read',
        resourceType: 'project_backend',
        resourceId: row.backendId,
        metadata: { name: row.name },
      });
      return c.json(
        {
          url,
          site_url: siteUrl,
          admin_key: adminKey,
          env: { CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
        },
        200,
      );
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends/{backendId}/token', tags: ['backends'],
      summary: 'Mint a Kortix sign-in token for the backend', ...auth,
      description:
        'A one-hour JWT naming the caller (`subject` = Kortix user id, `email`). The backend verifies it ' +
        'with the key Kortix wrote into its environment; read it in a function with `ctx.auth.getUserIdentity()`.',
      request: { params: BackendParams },
      responses: { 200: json(BackendToken, 'Token'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (row.status !== 'running') {
        return c.json({ error: `backend is ${effectiveStatus(row)}`, code: 'backend_not_running' }, 409);
      }
      const identity = await resolveAppViewerIdentity(loaded.userId);
      const minted = backendMemberToken(row, { userId: loaded.userId, email: identity.email });
      if (!minted) {
        return c.json({ error: 'this backend predates Kortix sign-in; create a new backend', code: 'backend_auth_unavailable' }, 409);
      }
      return c.json({ token: minted.token, expires_at: minted.expiresAt.toISOString() }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/backends/{backendId}', tags: ['backends'],
      summary: 'Delete a backend', ...auth,
      description: 'Deletes the machine and every document and file in it. This cannot be undone.',
      request: { params: BackendParams },
      responses: { 204: { description: 'Deleted' }, ...errors(403, 404, 502) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        await deleteBackend(row);
      } catch (error) {
        logger.error('[backends] delete failed', { projectId, backendId, error: String(error) });
        return c.json({ error: 'The backend machine could not be deleted. Try again.', code: 'backend_delete_failed' }, 502);
      }
      return c.body(null, 204);
    },
  );
}
