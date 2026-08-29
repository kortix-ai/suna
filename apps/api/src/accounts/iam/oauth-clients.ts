// IAM V2 routes: OAuth clients — "Sign in with Kortix" app registration.
//
// A client is a third-party app that signs Kortix users in through /v1/oauth
// and then acts as them (scope `kortix`) or just identifies them (`profile`).
// It is an account-owned credential like a service account, so it lives under
// the same `token.*` permission family: reading the registry needs
// `token.read`, registering/editing/rotating needs `token.create`, deleting
// needs `token.revoke`. The client secret is returned exactly once.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import {
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClient,
  listOAuthClients,
  normalizeClientType,
  normalizeRedirectUris,
  normalizeScopes,
  OAuthClientInputError,
  rotateOAuthClientSecret,
  updateOAuthClient,
  type OAuthClient,
} from '../../repositories/oauth-clients';
import { OAUTH_SCOPES } from '../../oauth/access-token';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, readBody } from './helpers';

export const OAuthClientSchema = z
  .object({
    client_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    client_type: z.enum(['confidential', 'public']),
    redirect_uris: z.array(z.string()),
    scopes: z.array(z.string()),
    active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    /** Present ONLY on create and rotate-secret responses, and only for confidential clients. */
    client_secret: z.string().nullable().optional(),
  })
  .openapi('IamOAuthClient');

const ClientParams = z.object({ accountId: z.string(), clientId: z.string() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serialize(client: OAuthClient, clientSecret?: string | null) {
  return {
    client_id: client.clientId,
    name: client.name,
    description: client.description,
    client_type: client.clientType,
    redirect_uris: client.redirectUris,
    scopes: client.scopes,
    active: client.active,
    created_at: client.createdAt.toISOString(),
    updated_at: client.updatedAt.toISOString(),
    ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
  };
}

function inputError(c: any, err: unknown) {
  if (err instanceof OAuthClientInputError) return c.json({ error: err.message }, 400);
  throw err;
}

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/oauth-clients',
    tags: ['iam'],
    summary: 'List OAuth clients (Sign in with Kortix apps)',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(
        z.object({ oauth_clients: z.array(OAuthClientSchema), scopes_supported: z.array(z.string()) }),
        'OAuth clients registered by this account',
      ),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_READ);
    const rows = await listOAuthClients(accountId);
    return c.json({ oauth_clients: rows.map((r) => serialize(r)), scopes_supported: [...OAUTH_SCOPES] });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/oauth-clients',
    tags: ['iam'],
    summary: 'Register an OAuth client',
    ...auth,
    request: {
      params: AccountIdParam,
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string(),
              description: z.string().optional(),
              client_type: z.enum(['confidential', 'public']).optional(),
              redirect_uris: z.array(z.string()),
              scopes: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(OAuthClientSchema, 'The registered client (secret shown once for a confidential client)'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE);

    const body = await readBody(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (name.length > 255) return c.json({ error: 'name too long (max 255)' }, 400);
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 1024) || null : null;
    let clientType, redirectUris, scopes;
    try {
      clientType = normalizeClientType(body.client_type);
      redirectUris = normalizeRedirectUris(body.redirect_uris);
      scopes = normalizeScopes(body.scopes ?? ['profile', 'email', 'kortix']);
    } catch (err) {
      return inputError(c, err);
    }

    const created = await createOAuthClient({
      accountId,
      createdBy: userId,
      name,
      description,
      clientType,
      redirectUris,
      scopes,
    });
    await auditIam(c, {
      accountId,
      action: 'iam.oauth_client.create',
      resourceType: 'oauth_client',
      resourceId: created.clientId,
      after: { name, client_type: clientType, redirect_uris: redirectUris, scopes },
    });
    return c.json(serialize(created, created.clientSecret), 201);
  },
);

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/oauth-clients/{clientId}',
    tags: ['iam'],
    summary: 'Get one OAuth client',
    ...auth,
    request: { params: ClientParams },
    responses: { 200: json(OAuthClientSchema, 'The client'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const clientId = c.req.param('clientId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_READ);
    const client = UUID.test(clientId) ? await getOAuthClient(accountId, clientId) : null;
    if (!client) return c.json({ error: 'OAuth client not found' }, 404);
    return c.json(serialize(client));
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/oauth-clients/{clientId}',
    tags: ['iam'],
    summary: 'Update an OAuth client (name, description, redirect URIs, scopes, active)',
    ...auth,
    request: {
      params: ClientParams,
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().optional(),
              description: z.string().nullable().optional(),
              redirect_uris: z.array(z.string()).optional(),
              scopes: z.array(z.string()).optional(),
              active: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(OAuthClientSchema, 'The updated client'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const clientId = c.req.param('clientId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE);
    const before = UUID.test(clientId) ? await getOAuthClient(accountId, clientId) : null;
    if (!before) return c.json({ error: 'OAuth client not found' }, 404);

    const body = await readBody(c);
    const patch: Parameters<typeof updateOAuthClient>[2] = {};
    try {
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return c.json({ error: 'name must not be empty' }, 400);
        if (name.length > 255) return c.json({ error: 'name too long (max 255)' }, 400);
        patch.name = name;
      }
      if (body.description !== undefined) {
        patch.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1024) || null : null;
      }
      if (body.redirect_uris !== undefined) patch.redirectUris = normalizeRedirectUris(body.redirect_uris);
      if (body.scopes !== undefined) patch.scopes = normalizeScopes(body.scopes);
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') return c.json({ error: 'active must be a boolean' }, 400);
        patch.active = body.active;
      }
    } catch (err) {
      return inputError(c, err);
    }

    const updated = await updateOAuthClient(accountId, clientId, patch);
    if (!updated) return c.json({ error: 'OAuth client not found' }, 404);
    await auditIam(c, {
      accountId,
      action: 'iam.oauth_client.update',
      resourceType: 'oauth_client',
      resourceId: clientId,
      before: { name: before.name, redirect_uris: before.redirectUris, scopes: before.scopes, active: before.active },
      after: { name: updated.name, redirect_uris: updated.redirectUris, scopes: updated.scopes, active: updated.active },
    });
    return c.json(serialize(updated));
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/oauth-clients/{clientId}/rotate-secret',
    tags: ['iam'],
    summary: 'Rotate a confidential client secret (returned once)',
    ...auth,
    request: { params: ClientParams },
    responses: { 200: json(OAuthClientSchema, 'The client with its new secret'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const clientId = c.req.param('clientId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE);
    let rotated;
    try {
      rotated = UUID.test(clientId) ? await rotateOAuthClientSecret(accountId, clientId) : null;
    } catch (err) {
      return inputError(c, err);
    }
    if (!rotated) return c.json({ error: 'OAuth client not found' }, 404);
    await auditIam(c, {
      accountId,
      action: 'iam.oauth_client.rotate_secret',
      resourceType: 'oauth_client',
      resourceId: clientId,
    });
    return c.json(serialize(rotated, rotated.clientSecret));
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/oauth-clients/{clientId}',
    tags: ['iam'],
    summary: 'Delete an OAuth client (revokes every token it minted)',
    ...auth,
    request: { params: ClientParams },
    responses: { 200: json(z.object({ deleted: z.boolean() }), 'Deleted'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const clientId = c.req.param('clientId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_REVOKE);
    const before = UUID.test(clientId) ? await getOAuthClient(accountId, clientId) : null;
    if (!before) return c.json({ error: 'OAuth client not found' }, 404);
    const deleted = await deleteOAuthClient(accountId, clientId);
    if (!deleted) return c.json({ error: 'OAuth client not found' }, 404);
    await auditIam(c, {
      accountId,
      action: 'iam.oauth_client.delete',
      resourceType: 'oauth_client',
      resourceId: clientId,
      before: { name: before.name, client_type: before.clientType },
    });
    return c.json({ deleted: true });
  },
);
