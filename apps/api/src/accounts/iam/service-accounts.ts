// IAM V2 routes: service accounts (non-human IAM principals).
// First-class machine identities owned by the account itself. Policies
// attach via principal_type='token' with principal_id=service_account_id
// — the engine's token-as-principal short-circuit means SA requests are
// evaluated PURELY against the SA's own policies (no minter inheritance).

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  getServiceAccount,
  listServiceAccounts,
} from '../../repositories/service-accounts';
import { iamRouter, AccountIdParam, ServiceAccountSchema } from './app';
import { auditIam, isUniqueViolation, readBody } from './helpers';

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/service-accounts',
    tags: ['iam'],
    summary: 'List service accounts',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ service_accounts: z.array(ServiceAccountSchema) }), 'Service accounts'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_READ);
  const rows = await listServiceAccounts(accountId);
  return c.json({
    service_accounts: rows.map((sa) => ({
      service_account_id: sa.serviceAccountId,
      name: sa.name,
      description: sa.description,
      public_prefix: sa.publicPrefix,
      status: sa.status,
      last_used_at: sa.lastUsedAt?.toISOString() ?? null,
      expires_at: sa.expiresAt?.toISOString() ?? null,
      created_at: sa.createdAt.toISOString(),
      disabled_at: sa.disabledAt?.toISOString() ?? null,
    })),
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/service-accounts',
    tags: ['iam'],
    summary: 'Create a service account',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string(), description: z.string().optional(), expires_at: z.string().optional() }) } } } },
    responses: {
      201: json(ServiceAccountSchema, 'The created service account (secret shown once)'),
      ...errors(400, 401, 403, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_CREATE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long (max 128)' }, 400);
  const description =
    typeof body.description === 'string' ? body.description.trim() || null : null;
  const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: 'expires_at must be ISO-8601' }, 400);
  }

  try {
    const created = await createServiceAccount({
      accountId,
      name,
      description,
      expiresAt,
      createdBy: userId,
    });
    await auditIam(c, {
      accountId,
      action: 'iam.service_account.create',
      resourceType: 'service_account',
      resourceId: created.serviceAccountId,
      after: { name: created.name, description: created.description },
    });
    return c.json(
      {
        service_account_id: created.serviceAccountId,
        name: created.name,
        description: created.description,
        public_prefix: created.publicPrefix,
        status: created.status,
        expires_at: created.expiresAt?.toISOString() ?? null,
        created_at: created.createdAt.toISOString(),
        /** Plaintext bearer — shown ONCE. Store it now or rotate. */
        secret: created.secret,
      },
      201,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A service account with that name already exists.' }, 409);
    }
    throw err;
  }
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/service-accounts/{saId}/disable',
    tags: ['iam'],
    summary: 'Disable a service account',
    ...auth,
    request: { params: z.object({ accountId: z.string(), saId: z.string() }) },
    responses: {
      200: json(z.object({ disabled: z.boolean() }), 'Disable result'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const saId = c.req.param('saId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE);

  const before = await getServiceAccount(accountId, saId);
  if (!before) return c.json({ error: 'service account not found' }, 404);
  const ok = await disableServiceAccount({
    accountId,
    serviceAccountId: saId,
    disabledBy: userId,
  });
  if (!ok) return c.json({ error: 'service account is already disabled' }, 409);

  await auditIam(c, {
    accountId,
    action: 'iam.service_account.disable',
    resourceType: 'service_account',
    resourceId: saId,
    before: { name: before.name, status: before.status },
    after: { name: before.name, status: 'disabled' },
  });
  return c.json({ disabled: true });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/service-accounts/{saId}',
    tags: ['iam'],
    summary: 'Delete a service account',
    ...auth,
    request: { params: z.object({ accountId: z.string(), saId: z.string() }) },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const saId = c.req.param('saId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE);

  const before = await getServiceAccount(accountId, saId);
  if (!before) return c.json({ error: 'service account not found' }, 404);
  await deleteServiceAccount(accountId, saId);

  await auditIam(c, {
    accountId,
    action: 'iam.service_account.delete',
    resourceType: 'service_account',
    resourceId: saId,
    before: { name: before.name },
  });
  return c.json({ deleted: true });
  },
);
