// IAM V2 routes: SCIM provisioning tokens.
// Bearer credentials configured in the customer's IdP (Okta, Azure AD, …)
// to drive /scim/v2/accounts/:accountId/*. Treated as account-admin-level
// secrets: only `account.write` can mint or revoke. Plaintext is returned
// exactly once at mint; everything else shows the public prefix only.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
} from '../../repositories/scim';
import { iamRouter, AccountIdParam, ScimTokenSchema } from './app';
import { auditIam, readBody } from './helpers';

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/scim/tokens',
    tags: ['iam'],
    summary: 'List SCIM provisioning tokens',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ tokens: z.array(ScimTokenSchema) }), 'SCIM tokens'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const tokens = await listScimTokens(accountId);
  return c.json({
    tokens: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_prefix: t.publicPrefix,
      status: t.status,
      created_at: t.createdAt.toISOString(),
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      expires_at: t.expiresAt?.toISOString() ?? null,
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/scim/tokens',
    tags: ['iam'],
    summary: 'Mint a SCIM provisioning token',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string(), expires_at: z.string().optional(), expiresAt: z.string().optional() }) } } } },
    responses: {
      201: json(ScimTokenSchema, 'The minted SCIM token (secret shown once)'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 128) return c.json({ error: 'name too long (max 128 chars)' }, 400);

  const expiresAtRaw =
    typeof body.expires_at === 'string'
      ? body.expires_at
      : typeof body.expiresAt === 'string'
        ? body.expiresAt
        : null;
  let expiresAt: Date | undefined;
  if (expiresAtRaw) {
    const d = new Date(expiresAtRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: 'expires_at must be ISO-8601' }, 400);
    }
    if (d.getTime() <= Date.now()) {
      return c.json({ error: 'expires_at must be in the future' }, 400);
    }
    expiresAt = d;
  }

  const created = await createScimToken({
    accountId,
    name,
    createdBy: userId,
    expiresAt,
  });

  await auditIam(c, {
    accountId,
    action: 'iam.scim.token.create',
    resourceType: 'scim_token',
    resourceId: created.tokenId,
    after: {
      name: created.name,
      public_prefix: created.publicPrefix,
      expires_at: created.expiresAt?.toISOString() ?? null,
    },
  });

  // The secret is returned ONCE. Subsequent list calls only see the
  // public prefix. Audit never logs the secret.
  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      secret: created.secret,
      public_prefix: created.publicPrefix,
      created_at: created.createdAt.toISOString(),
      expires_at: created.expiresAt?.toISOString() ?? null,
      scim_base_url: `/scim/v2/accounts/${accountId}`,
    },
    201,
  );
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/scim/tokens/{tokenId}',
    tags: ['iam'],
    summary: 'Revoke a SCIM provisioning token',
    ...auth,
    request: { params: z.object({ accountId: z.string(), tokenId: z.string() }) },
    responses: {
      200: json(z.object({ revoked: z.boolean() }), 'Revocation result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const tokenId = c.req.param('tokenId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const ok = await revokeScimToken(accountId, tokenId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.scim.token.revoke',
    resourceType: 'scim_token',
    resourceId: tokenId,
  });

  return c.json({ revoked: true });
  },
);
