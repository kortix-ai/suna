// IAM V2 routes: SAML SSO provider config + group mappings.
// The Supabase auth.sso_providers row is created out-of-band (via Studio
// or the auth admin API — admins paste the IdP metadata there). We just
// record which kortix account owns it plus the claim mapping config. JIT
// provisioning + group sync runs in the auth middleware on every request.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  createSsoGroupMapping,
  deleteSsoGroupMapping,
  deleteSsoProvider,
  getSsoProvider,
  listSsoGroupMappings,
  upsertSsoProvider,
} from '../../repositories/sso';
import {
  iamRouter,
  AccountIdParam,
  SsoProviderSchema,
  SsoMappingSchema,
} from './app';
import { auditIam, isUniqueViolation, readBody } from './helpers';

function ssoProviderResponse(p: NonNullable<Awaited<ReturnType<typeof getSsoProvider>>>) {
  return {
    sso_provider_id: p.ssoProviderId,
    supabase_sso_provider_id: p.supabaseSsoProviderId,
    name: p.name,
    primary_domain: p.primaryDomain,
    group_claim_name: p.groupClaimName,
    auto_create_members: p.autoCreateMembers,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Get the account SSO provider',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema.nullable() }), 'The SSO provider, or null'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const p = await getSsoProvider(accountId);
  if (!p) return c.json({ provider: null });
  return c.json({ provider: ssoProviderResponse(p) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Create or update the SSO provider',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ supabase_sso_provider_id: z.string().optional(), supabaseSsoProviderId: z.string().optional(), name: z.string().optional(), primary_domain: z.string().optional(), primaryDomain: z.string().optional(), group_claim_name: z.string().optional(), groupClaimName: z.string().optional(), auto_create_members: z.boolean().optional(), autoCreateMembers: z.boolean().optional() }) } } } },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema }), 'The upserted SSO provider'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const supabaseSsoProviderId = (body.supabase_sso_provider_id ?? body.supabaseSsoProviderId) as unknown;
  const name = body.name as unknown;
  const primaryDomain = (body.primary_domain ?? body.primaryDomain) as unknown;
  const groupClaimName = (body.group_claim_name ?? body.groupClaimName) as unknown;
  const autoCreateMembers = (body.auto_create_members ?? body.autoCreateMembers) as unknown;

  if (typeof supabaseSsoProviderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(supabaseSsoProviderId)) {
    return c.json({ error: 'supabase_sso_provider_id must be a UUID' }, 400);
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (
    typeof primaryDomain !== 'string' ||
    primaryDomain.trim().length === 0 ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(primaryDomain.trim())
  ) {
    return c.json({ error: 'primary_domain must be a valid domain' }, 400);
  }
  if (groupClaimName !== undefined && (typeof groupClaimName !== 'string' || groupClaimName.length > 128)) {
    return c.json({ error: 'group_claim_name must be a short string' }, 400);
  }

  const before = await getSsoProvider(accountId);
  const provider = await upsertSsoProvider({
    accountId,
    supabaseSsoProviderId,
    name: name.trim(),
    primaryDomain: primaryDomain.trim(),
    groupClaimName: typeof groupClaimName === 'string' ? groupClaimName : undefined,
    autoCreateMembers: typeof autoCreateMembers === 'boolean' ? autoCreateMembers : undefined,
  createdBy: userId,
  });

  await auditIam(c, {
    accountId,
    action: before ? 'iam.sso.provider.update' : 'iam.sso.provider.create',
    resourceType: 'sso_provider',
    resourceId: provider.ssoProviderId,
    before: before
      ? {
          supabase_sso_provider_id: before.supabaseSsoProviderId,
          name: before.name,
          primary_domain: before.primaryDomain,
          group_claim_name: before.groupClaimName,
          auto_create_members: before.autoCreateMembers,
        }
      : null,
    after: {
      supabase_sso_provider_id: provider.supabaseSsoProviderId,
      name: provider.name,
      primary_domain: provider.primaryDomain,
      group_claim_name: provider.groupClaimName,
      auto_create_members: provider.autoCreateMembers,
    },
  });

  return c.json({ provider: ssoProviderResponse(provider) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/sso/provider',
    tags: ['iam'],
    summary: 'Delete the SSO provider',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const before = await getSsoProvider(accountId);
  const ok = await deleteSsoProvider(accountId);
  if (!ok) return c.json({ error: 'no SSO provider configured' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.sso.provider.delete',
    resourceType: 'sso_provider',
    resourceId: before?.ssoProviderId ?? accountId,
    before: before
      ? {
          supabase_sso_provider_id: before.supabaseSsoProviderId,
          name: before.name,
          primary_domain: before.primaryDomain,
        }
      : null,
  });

  return c.json({ deleted: true });
  },
);

// ─── SAML group mappings ──────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/sso/mappings',
    tags: ['iam'],
    summary: 'List SSO group mappings',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ mappings: z.array(SsoMappingSchema) }), 'SSO group mappings'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const rows = await listSsoGroupMappings(accountId);
  return c.json({
    mappings: rows.map((m) => ({
      mapping_id: m.mappingId,
      claim_value: m.claimValue,
      group_id: m.groupId,
      group_name: m.groupName,
      created_at: m.createdAt.toISOString(),
    })),
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/sso/mappings',
    tags: ['iam'],
    summary: 'Create an SSO group mapping',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ claim_value: z.string().optional(), claimValue: z.string().optional(), group_id: z.string().optional(), groupId: z.string().optional() }) } } } },
    responses: {
      201: json(SsoMappingSchema, 'The created mapping'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const claimValue = (body.claim_value ?? body.claimValue) as unknown;
  const groupId = (body.group_id ?? body.groupId) as unknown;
  if (typeof claimValue !== 'string' || claimValue.trim().length === 0) {
    return c.json({ error: 'claim_value is required' }, 400);
  }
  if (typeof groupId !== 'string' || !/^[0-9a-f-]{36}$/i.test(groupId)) {
    return c.json({ error: 'group_id must be a UUID' }, 400);
  }
  const provider = await getSsoProvider(accountId);
  if (!provider) {
    return c.json({ error: 'no SSO provider configured — set one first' }, 409);
  }

  try {
    const mapping = await createSsoGroupMapping({
      accountId,
      ssoProviderId: provider.ssoProviderId,
      claimValue: claimValue.trim(),
      groupId,
      createdBy: userId,
    });
    if (!mapping) return c.json({ error: 'group not found in this account' }, 404);

    await auditIam(c, {
      accountId,
      action: 'iam.sso.mapping.create',
      resourceType: 'sso_mapping',
      resourceId: mapping.mappingId,
      after: {
        claim_value: mapping.claimValue,
        group_id: mapping.groupId,
        group_name: mapping.groupName,
      },
    });

    return c.json(
      {
        mapping_id: mapping.mappingId,
        claim_value: mapping.claimValue,
        group_id: mapping.groupId,
        group_name: mapping.groupName,
        created_at: mapping.createdAt.toISOString(),
      },
      201,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'A mapping for that claim value already exists.' }, 409);
    }
    throw err;
  }
  },
);

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/sso/mappings/{mappingId}',
    tags: ['iam'],
    summary: 'Delete an SSO group mapping',
    ...auth,
    request: { params: z.object({ accountId: z.string(), mappingId: z.string() }) },
    responses: {
      200: json(z.object({ deleted: z.boolean() }), 'Deletion result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const mappingId = c.req.param('mappingId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const ok = await deleteSsoGroupMapping(accountId, mappingId);
  if (!ok) return c.json({ error: 'mapping not found' }, 404);

  await auditIam(c, {
    accountId,
    action: 'iam.sso.mapping.delete',
    resourceType: 'sso_mapping',
    resourceId: mappingId,
  });

  return c.json({ deleted: true });
  },
);
