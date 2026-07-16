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
import { auditIam, isUniqueViolation, readBody, requireEntitlement } from './helpers';
import {
  deleteSupabaseSamlProvider,
  registerSupabaseSamlProvider,
  syncSupabaseSamlAttributeMapping,
} from './sso-provisioning';

function ssoProviderResponse(p: NonNullable<Awaited<ReturnType<typeof getSsoProvider>>>) {
  return {
    sso_provider_id: p.ssoProviderId,
    supabase_sso_provider_id: p.supabaseSsoProviderId,
    name: p.name,
    primary_domain: p.primaryDomain,
    group_claim_name: p.groupClaimName,
    auto_create_members: p.autoCreateMembers,
    auto_provision_groups: p.autoProvisionGroups,
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
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ supabase_sso_provider_id: z.string().optional(), supabaseSsoProviderId: z.string().optional(), name: z.string().optional(), primary_domain: z.string().optional(), primaryDomain: z.string().optional(), group_claim_name: z.string().optional(), groupClaimName: z.string().optional(), auto_create_members: z.boolean().optional(), autoCreateMembers: z.boolean().optional(), auto_provision_groups: z.boolean().optional(), autoProvisionGroups: z.boolean().optional() }) } } } },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema }), 'The upserted SSO provider'),
      ...errors(400, 401, 402, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const denied = await requireEntitlement(c, accountId, 'sso');
  if (denied) return denied;

  const body = await readBody(c);
  const supabaseSsoProviderId = (body.supabase_sso_provider_id ?? body.supabaseSsoProviderId) as unknown;
  const name = body.name as unknown;
  const primaryDomain = (body.primary_domain ?? body.primaryDomain) as unknown;
  const groupClaimName = (body.group_claim_name ?? body.groupClaimName) as unknown;
  const autoCreateMembers = (body.auto_create_members ?? body.autoCreateMembers) as unknown;
  const autoProvisionGroups = (body.auto_provision_groups ?? body.autoProvisionGroups) as unknown;

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
    autoProvisionGroups: typeof autoProvisionGroups === 'boolean' ? autoProvisionGroups : undefined,
    createdBy: userId,
  });

  // Keep Supabase's attribute_mapping in step with the (possibly changed) group
  // claim name, so the IdP's group values actually reach the JWT — Supabase drops
  // any SAML attribute not named in the mapping. Best-effort: the Kortix config is
  // already persisted, so a Supabase hiccup here must not fail the save.
  if (provider.supabaseSsoProviderId) {
    const synced = await syncSupabaseSamlAttributeMapping(
      provider.supabaseSsoProviderId,
      provider.groupClaimName,
    );
    if (!synced.ok) {
      console.warn(
        `[sso] attribute_mapping sync failed for account ${accountId}: ${synced.error}`,
      );
    }
  }

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
          auto_provision_groups: before.autoProvisionGroups,
        }
      : null,
    after: {
      supabase_sso_provider_id: provider.supabaseSsoProviderId,
      name: provider.name,
      primary_domain: provider.primaryDomain,
      group_claim_name: provider.groupClaimName,
      auto_create_members: provider.autoCreateMembers,
      auto_provision_groups: provider.autoProvisionGroups,
    },
  });

  return c.json({ provider: ssoProviderResponse(provider) });
  },
);

// Self-serve: register the customer's Entra/IdP SAML metadata with Supabase Auth
// server-side (no operator `supabase sso add`), then store the resulting UUID.
// The admin pastes their metadata XML (or URL) in the dashboard and never sees
// Supabase. One IdP per account in v1 — remove the existing one to re-import.
iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/sso/provider/from-metadata',
    tags: ['iam'],
    summary: 'Register a SAML provider from IdP metadata (self-serve)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: {
        content: {
          'application/json': {
            schema: z.object({
              metadata_xml: z.string().optional(),
              metadata_url: z.string().optional(),
              name: z.string(),
              primary_domain: z.string(),
              group_claim_name: z.string().optional(),
              auto_create_members: z.boolean().optional(),
              auto_provision_groups: z.boolean().optional(),
              domains: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ provider: SsoProviderSchema }), 'The registered SSO provider'),
      ...errors(400, 401, 402, 403, 409),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    const denied = await requireEntitlement(c, accountId, 'sso');
    if (denied) return denied;

    const body = await readBody(c);
    const name = body.name as unknown;
    const primaryDomain = (body.primary_domain ?? body.primaryDomain) as unknown;
    const metadataXml = (body.metadata_xml ?? body.metadataXml) as unknown;
    const metadataUrl = (body.metadata_url ?? body.metadataUrl) as unknown;
    const groupClaimName = (body.group_claim_name ?? body.groupClaimName) as unknown;
    const autoCreateMembers = (body.auto_create_members ?? body.autoCreateMembers) as unknown;
    const autoProvisionGroups = (body.auto_provision_groups ?? body.autoProvisionGroups) as unknown;

    if (typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'name is required' }, 400);
    }
    if (
      typeof primaryDomain !== 'string' ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(primaryDomain.trim())
    ) {
      return c.json({ error: 'primary_domain must be a valid domain' }, 400);
    }
    if (groupClaimName !== undefined && (typeof groupClaimName !== 'string' || groupClaimName.length > 128)) {
      return c.json({ error: 'group_claim_name must be a short string' }, 400);
    }

    // One IdP per account (v1). Registering again would orphan the old Supabase
    // provider — make the admin delete first (which also frees the domain).
    const existing = await getSsoProvider(accountId);
    if (existing) {
      return c.json(
        { error: 'An SSO provider already exists — remove it before importing a new one.' },
        409,
      );
    }

    // Additional email domains beyond the primary (e.g. subsidiaries) may be
    // passed; always include the primary so sign-in routing works.
    const extra = Array.isArray(body.domains)
      ? (body.domains as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const domains = [...new Set([primaryDomain.trim().toLowerCase(), ...extra.map((d) => d.trim().toLowerCase())])];

    const registered = await registerSupabaseSamlProvider({
      metadataXml: typeof metadataXml === 'string' ? metadataXml : undefined,
      metadataUrl: typeof metadataUrl === 'string' ? metadataUrl : undefined,
      domains,
      // Register WITH the group-claim mapping so the claim reaches the JWT from
      // the very first login (defaults to `groups` when omitted).
      groupClaimName: typeof groupClaimName === 'string' ? groupClaimName : undefined,
    });
    if (!registered.ok) return c.json({ error: registered.error }, registered.status as 400);

    const provider = await upsertSsoProvider({
      accountId,
      supabaseSsoProviderId: registered.providerId,
      name: name.trim(),
      primaryDomain: primaryDomain.trim(),
      groupClaimName: typeof groupClaimName === 'string' ? groupClaimName : undefined,
      autoCreateMembers: typeof autoCreateMembers === 'boolean' ? autoCreateMembers : undefined,
      autoProvisionGroups: typeof autoProvisionGroups === 'boolean' ? autoProvisionGroups : undefined,
      createdBy: userId,
    });

    await auditIam(c, {
      accountId,
      action: 'iam.sso.provider.create',
      resourceType: 'sso_provider',
      resourceId: provider.ssoProviderId,
      before: null,
      after: {
        supabase_sso_provider_id: provider.supabaseSsoProviderId,
        name: provider.name,
        primary_domain: provider.primaryDomain,
        group_claim_name: provider.groupClaimName,
        auto_create_members: provider.autoCreateMembers,
        auto_provision_groups: provider.autoProvisionGroups,
        source: 'metadata_import',
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
  // Disconnecting SSO must never 402 — an account that lost its entitlement
  // still needs to be able to turn the IdP integration off.

  const before = await getSsoProvider(accountId);
  const ok = await deleteSsoProvider(accountId);
  if (!ok) return c.json({ error: 'no SSO provider configured' }, 404);

  // Unregister the provider in Supabase too — that's what frees the email
  // domain so the admin can re-import it later. Best-effort: the Kortix row is
  // already gone and disconnect must never fail, so a Supabase hiccup is logged
  // (leaving a reclaimable orphan) rather than surfaced. A 404 counts as ok.
  if (before?.supabaseSsoProviderId) {
    const unregistered = await deleteSupabaseSamlProvider(before.supabaseSsoProviderId);
    if (!unregistered.ok) {
      console.warn(
        `[sso] Supabase provider deletion failed for account ${accountId}: ${unregistered.error}`,
      );
    }
  }

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
      ...errors(400, 401, 402, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const denied = await requireEntitlement(c, accountId, 'sso');
  if (denied) return denied;

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
  // Reduction-only action (removes a group mapping) — must never 402.

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
