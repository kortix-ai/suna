import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { accountMembers, kortixApiKeys, sandboxes, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { supabaseAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, auth } from '../../openapi';
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  revokeApiKey,
  type CreateApiKeyResult,
} from '../../repositories/api-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SandboxRef =
  | { table: 'session'; sandboxId: string; accountId: string; config: Record<string, unknown> | null }
  | { table: 'legacy'; sandboxId: string; accountId: string; config: Record<string, unknown> | null };

function serializeKey(row: {
  keyId: string;
  publicKey: string;
  sandboxId: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  expiresAt: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
}) {
  return {
    key_id: row.keyId,
    public_key: row.publicKey,
    sandbox_id: row.sandboxId,
    title: row.title,
    description: row.description ?? undefined,
    type: row.type,
    status: row.expiresAt && row.expiresAt < new Date() ? 'expired' : row.status,
    expires_at: row.expiresAt?.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}

function serializeCreatedKey(row: CreateApiKeyResult) {
  return {
    key_id: row.keyId,
    public_key: row.publicKey,
    secret_key: row.secretKey,
    sandbox_id: row.sandboxId,
    title: row.title,
    description: row.description ?? undefined,
    type: row.type,
    status: row.status,
    expires_at: row.expiresAt?.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}

async function getAccountRole(userId: string, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return row?.accountRole ?? null;
}

async function requireSandboxAccess(c: any, sandboxId: string): Promise<SandboxRef> {
  if (!UUID_RE.test(sandboxId)) {
    throw new HTTPException(400, { message: 'sandbox_id must be a UUID' });
  }

  const [sessionRow] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      accountId: sessionSandboxes.accountId,
      config: sessionSandboxes.config,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .limit(1);

  let legacyRow: { sandboxId: string; accountId: string; config: Record<string, unknown> | null } | undefined;
  if (!sessionRow) {
    [legacyRow] = await db
      .select({
        sandboxId: sandboxes.sandboxId,
        accountId: sandboxes.accountId,
        config: sandboxes.config,
      })
      .from(sandboxes)
      .where(eq(sandboxes.sandboxId, sandboxId))
      .limit(1);
  }

  const ref: SandboxRef | null = sessionRow
    ? { table: 'session', sandboxId: sessionRow.sandboxId, accountId: sessionRow.accountId, config: sessionRow.config ?? null }
    : legacyRow
      ? { table: 'legacy', sandboxId: legacyRow.sandboxId, accountId: legacyRow.accountId, config: legacyRow.config ?? null }
      : null;

  if (!ref) {
    throw new HTTPException(404, { message: 'Sandbox not found' });
  }

  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    throw new HTTPException(401, { message: 'User credentials are required' });
  }

  const accountRole = await getAccountRole(userId, ref.accountId);
  if (accountRole !== 'owner' && accountRole !== 'admin') {
    throw new HTTPException(403, { message: 'Owner or admin role required to manage API keys' });
  }

  return ref;
}

async function requireKeyAccess(c: any, keyId: string) {
  const [row] = await db
    .select({
      keyId: kortixApiKeys.keyId,
      accountId: kortixApiKeys.accountId,
      sandboxId: kortixApiKeys.sandboxId,
      publicKey: kortixApiKeys.publicKey,
      title: kortixApiKeys.title,
      description: kortixApiKeys.description,
      type: kortixApiKeys.type,
      status: kortixApiKeys.status,
      expiresAt: kortixApiKeys.expiresAt,
      lastUsedAt: kortixApiKeys.lastUsedAt,
      createdAt: kortixApiKeys.createdAt,
    })
    .from(kortixApiKeys)
    .where(eq(kortixApiKeys.keyId, keyId))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'API key not found' });
  }
  await requireSandboxAccess(c, row.sandboxId);
  return row;
}

async function updateSandboxServiceKey(ref: SandboxRef, secretKey: string) {
  const nextConfig = { ...(ref.config ?? {}), serviceKey: secretKey };
  if (ref.table === 'session') {
    await db
      .update(sessionSandboxes)
      .set({ config: nextConfig, updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, ref.sandboxId));
    return;
  }
  await db
    .update(sandboxes)
    .set({ config: nextConfig, updatedAt: new Date() })
    .where(eq(sandboxes.sandboxId, ref.sandboxId));
}

// ─── Schemas ─────────────────────────────────────────────────────────────────
// api-keys is SANDBOX-scoped: GET requires ?sandbox_id, POST requires sandbox_id
// in the body. Validation stays MANUAL inside the handlers (missing → custom
// {success:false} 400 envelope, unknown → 404 via requireSandboxAccess); the
// schemas below only DOCUMENT the surface — they do not gate requests, so they
// can't reject currently-valid calls.

const ApiKeySchema = z
  .object({
    key_id: z.string(),
    public_key: z.string(),
    sandbox_id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    type: z.string(),
    status: z.string(),
    expires_at: z.string().optional(),
    last_used_at: z.string().optional(),
    created_at: z.string(),
  })
  .openapi('ApiKey');

const CreatedApiKeySchema = z
  .object({
    key_id: z.string(),
    public_key: z.string(),
    secret_key: z.string(),
    sandbox_id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    type: z.string(),
    status: z.string(),
    expires_at: z.string().optional(),
    created_at: z.string(),
  })
  .openapi('CreatedApiKey');

const KeyIdParamSchema = z.object({ keyId: z.string() });

/**
 * These routes return custom `{success:false, …}` envelopes for their own 400/404
 * cases (not the shared `{error,message,status}` shape), so declare them explicitly
 * so the typed handlers accept the exact bodies the handlers produce.
 */
const FailEnvelopeSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .openapi('ApiKeyError');

const failResponse = (description: string) => json(FailEnvelopeSchema, description);

export const apiKeysRouter = makeOpenApiApp<AppEnv>();

apiKeysRouter.use('*', supabaseAuth);

apiKeysRouter.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['platform'],
    summary: 'List API keys for a sandbox',
    ...auth,
    request: {
      query: z.object({ sandbox_id: z.string().optional() }),
    },
    responses: {
      200: json(
        z.object({ success: z.boolean(), data: z.array(ApiKeySchema) }),
        'API keys for the sandbox',
      ),
      400: failResponse('sandbox_id is required'),
    },
  }),
  async (c) => {
  const sandboxId = c.req.query('sandbox_id');
  if (!sandboxId) return c.json({ success: false, error: 'sandbox_id is required' }, 400);
  await requireSandboxAccess(c, sandboxId);
  const rows = await listApiKeys(sandboxId);
  return c.json({ success: true, data: rows.map(serializeKey) });
  },
);

apiKeysRouter.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['platform'],
    summary: 'Create an API key for a sandbox',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              sandbox_id: z.string(),
              title: z.string().optional(),
              description: z.string().optional(),
              expires_in_days: z.number().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(
        z.object({ success: z.boolean(), data: CreatedApiKeySchema }),
        'The created API key (includes the one-time secret)',
      ),
    },
  }),
  async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sandboxId = typeof body.sandbox_id === 'string' ? body.sandbox_id : '';
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'API Key';
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  const expiresInDays = typeof body.expires_in_days === 'number' && Number.isFinite(body.expires_in_days)
    ? Math.max(1, Math.min(Math.floor(body.expires_in_days), 3650))
    : null;

  const ref = await requireSandboxAccess(c, sandboxId);
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : undefined;
  const created = await createApiKey({
    sandboxId: ref.sandboxId,
    accountId: ref.accountId,
    title,
    description,
    expiresAt,
    type: 'user',
  });
  return c.json({ success: true, data: serializeCreatedKey(created) }, 201);
  },
);

apiKeysRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{keyId}/revoke',
    tags: ['platform'],
    summary: 'Revoke an API key',
    ...auth,
    request: { params: KeyIdParamSchema },
    responses: {
      200: json(z.object({ success: z.boolean(), message: z.string() }), 'API key revoked'),
      404: failResponse('API key was not active'),
    },
  }),
  async (c) => {
  const key = await requireKeyAccess(c, c.req.param('keyId'));
  const ok = await revokeApiKey(key.keyId, key.accountId);
  if (!ok) return c.json({ success: false, message: 'API key was not active' }, 404);
  return c.json({ success: true, message: 'API key revoked' });
  },
);

apiKeysRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{keyId}',
    tags: ['platform'],
    summary: 'Delete an API key',
    ...auth,
    request: { params: KeyIdParamSchema },
    responses: {
      200: json(z.object({ success: z.boolean(), message: z.string() }), 'API key deleted'),
      404: failResponse('API key not found'),
    },
  }),
  async (c) => {
  const key = await requireKeyAccess(c, c.req.param('keyId'));
  const ok = await deleteApiKey(key.keyId, key.accountId);
  if (!ok) return c.json({ success: false, message: 'API key not found' }, 404);
  return c.json({ success: true, message: 'API key deleted' });
  },
);

apiKeysRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{keyId}/regenerate',
    tags: ['platform'],
    summary: 'Regenerate a sandbox-managed API key',
    ...auth,
    request: { params: KeyIdParamSchema },
    responses: {
      200: json(
        z.object({
          success: z.boolean(),
          data: CreatedApiKeySchema,
          sandbox_updated: z.boolean(),
        }),
        'The regenerated key; the sandbox service key was updated',
      ),
      400: failResponse('Only sandbox-managed keys can be regenerated'),
    },
  }),
  async (c) => {
  const key = await requireKeyAccess(c, c.req.param('keyId'));
  if (key.type !== 'sandbox') {
    return c.json({ success: false, error: 'Only sandbox-managed keys can be regenerated' }, 400);
  }

  const ref = await requireSandboxAccess(c, key.sandboxId);
  await revokeApiKey(key.keyId, key.accountId);
  const created = await createApiKey({
    sandboxId: ref.sandboxId,
    accountId: ref.accountId,
    title: key.title || 'Sandbox Token',
    description: key.description ?? undefined,
    type: 'sandbox',
  });
  await updateSandboxServiceKey(ref, created.secretKey);

  return c.json({
    success: true,
    data: serializeCreatedKey(created),
    sandbox_updated: true,
  });
  },
);
