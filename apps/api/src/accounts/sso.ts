import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { supabaseAuth } from '../middleware/auth';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';
import { recordAuditEvent } from '../shared/audit';
import {
  createSsoConnection,
  createVerifiedDomain,
  deleteSsoConnection,
  deleteVerifiedDomain,
  isSsoAuthProvider,
  listAccountSsoSettings,
  normalizeSsoDomain,
  resolveSsoPolicyForDomain,
  ssoVerificationTxtValue,
  updateSsoConnection,
  verifyDomainDns,
  type AccountRole,
  type SsoConnectionStatus,
  type SsoProtocol,
} from '../repositories/account-sso';

export const accountSsoRouter = new Hono<AppEnv>();
export const authSsoRouter = new Hono<AppEnv>();

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === '23505' || (err as { code?: string }).code === '23505';
}

function parseString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseProtocol(value: unknown): SsoProtocol | null {
  if (value === undefined || value === null || value === '') return null;
  return value === 'saml' || value === 'oidc' ? value : null;
}

function parseStatus(value: unknown): SsoConnectionStatus | null {
  if (value === undefined || value === null || value === '') return null;
  return value === 'active' || value === 'disabled' ? value : null;
}

function parseDefaultRole(value: unknown): AccountRole | null {
  if (value === undefined || value === null || value === '') return null;
  return value === 'admin' || value === 'member' ? value : null;
}

function serializeDomain(row: any) {
  return {
    domain_id: row.domainId,
    account_id: row.accountId,
    domain: row.domain,
    status: row.status,
    verification_token: row.verificationToken,
    verification_txt: ssoVerificationTxtValue(row.verificationToken),
    verified_at: row.verifiedAt?.toISOString?.() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeConnection(row: any) {
  return {
    connection_id: row.connectionId,
    account_id: row.accountId,
    provider_id: row.providerId,
    provider_name: row.providerName,
    protocol: row.protocol,
    status: row.status,
    enforced: row.enforced,
    jit_provisioning_enabled: row.jitProvisioningEnabled,
    default_role: row.defaultRole,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function requireSsoAdmin(c: Context, accountId: string) {
  const userId = c.get('userId') as string;
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  return userId;
}

// Public pre-auth resolver used by /auth to find the right Supabase SSO
// provider before the user has a Kortix session.
authSsoRouter.get('/resolve-domain', async (c) => {
  const input = c.req.query('email') || c.req.query('domain') || '';
  const domain = normalizeSsoDomain(input);
  if (!domain) {
    return c.json({ domain: null, sso_available: false, sso_required: false });
  }

  const policy = await resolveSsoPolicyForDomain(domain);
  return c.json({
    domain: policy.domain,
    sso_available: policy.ssoAvailable,
    sso_required: policy.ssoRequired,
    provider_id: policy.providerId,
    provider_name: policy.providerName,
    protocol: policy.protocol,
    account_name: policy.accountName,
  });
});

// Called after Supabase exchanges an SSO code so account audit logs can show
// SSO sign-ins independently of Supabase's provider-side auth logs.
authSsoRouter.post('/login-event', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string;
  const email = c.get('userEmail') as string;
  const authProvider = c.get('authProvider');
  if (!email || !isSsoAuthProvider(authProvider)) {
    return c.json({ recorded: false });
  }

  const policy = await resolveSsoPolicyForDomain(email);
  if (!policy.accountId || !policy.providerId) {
    return c.json({ recorded: false });
  }

  await recordAuditEvent({
    accountId: policy.accountId,
    actorUserId: userId,
    action: 'auth.sso.login',
    resourceType: 'sso_connection',
    resourceId: policy.providerId,
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
    metadata: {
      domain: policy.domain,
      provider_name: policy.providerName,
      protocol: policy.protocol,
    },
  });

  return c.json({ recorded: true });
});

accountSsoRouter.get('/:accountId/security/sso', async (c) => {
  const accountId = c.req.param('accountId');
  const userId = c.get('userId') as string;
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const settings = await listAccountSsoSettings(accountId);
  return c.json({
    domains: settings.domains.map(serializeDomain),
    connections: settings.connections.map(serializeConnection),
  });
});

accountSsoRouter.post('/:accountId/security/sso/domains', async (c) => {
  const accountId = c.req.param('accountId');
  const userId = await requireSsoAdmin(c, accountId);
  const body = await readBody(c);
  const domain = parseString(body.domain);
  if (!domain || !normalizeSsoDomain(domain)) return c.json({ error: 'A valid domain is required' }, 400);

  try {
    const row = await createVerifiedDomain({ accountId, domain, createdBy: userId });
    return c.json(serializeDomain(row), 201);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'Domain is already registered' }, 409);
    if ((err as Error).message === 'invalid_domain') return c.json({ error: 'A valid domain is required' }, 400);
    throw err;
  }
});

accountSsoRouter.post('/:accountId/security/sso/domains/:domainId/verify', async (c) => {
  const accountId = c.req.param('accountId');
  await requireSsoAdmin(c, accountId);
  const result = await verifyDomainDns(accountId, c.req.param('domainId'));
  if (!result.ok) {
    if (result.reason === 'not_found') return c.json({ error: 'Domain not found' }, 404);
    return c.json({
      error: 'Verification TXT record not found',
      expected: result.expected,
      records: result.records,
    }, 409);
  }
  return c.json(serializeDomain(result.domain));
});

accountSsoRouter.delete('/:accountId/security/sso/domains/:domainId', async (c) => {
  const accountId = c.req.param('accountId');
  await requireSsoAdmin(c, accountId);
  const deleted = await deleteVerifiedDomain(accountId, c.req.param('domainId'));
  if (!deleted) return c.json({ error: 'Domain not found' }, 404);
  return c.json({ deleted: true });
});

accountSsoRouter.post('/:accountId/security/sso/connections', async (c) => {
  const accountId = c.req.param('accountId');
  const userId = await requireSsoAdmin(c, accountId);
  const body = await readBody(c);
  const providerId = parseString(body.provider_id);
  if (!providerId) return c.json({ error: 'provider_id is required' }, 400);
  const protocol = parseProtocol(body.protocol) ?? 'saml';
  const defaultRole = parseDefaultRole(body.default_role) ?? 'member';

  try {
    const row = await createSsoConnection({
      accountId,
      providerId,
      providerName: parseString(body.provider_name),
      protocol,
      enforced: typeof body.enforced === 'boolean' ? body.enforced : false,
      jitProvisioningEnabled:
        typeof body.jit_provisioning_enabled === 'boolean' ? body.jit_provisioning_enabled : true,
      defaultRole,
      createdBy: userId,
    });
    return c.json(serializeConnection(row), 201);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'SSO provider is already configured' }, 409);
    throw err;
  }
});

accountSsoRouter.patch('/:accountId/security/sso/connections/:connectionId', async (c) => {
  const accountId = c.req.param('accountId');
  await requireSsoAdmin(c, accountId);
  const body = await readBody(c);
  const patch: Parameters<typeof updateSsoConnection>[2] = {};

  if (body.provider_id !== undefined) {
    const providerId = parseString(body.provider_id);
    if (!providerId) return c.json({ error: 'provider_id is invalid' }, 400);
    patch.providerId = providerId;
  }
  if (body.provider_name !== undefined) patch.providerName = parseString(body.provider_name);
  if (body.protocol !== undefined) {
    const protocol = parseProtocol(body.protocol);
    if (!protocol) return c.json({ error: 'protocol must be saml or oidc' }, 400);
    patch.protocol = protocol;
  }
  if (body.status !== undefined) {
    const status = parseStatus(body.status);
    if (!status) return c.json({ error: 'status must be active or disabled' }, 400);
    patch.status = status;
  }
  if (body.enforced !== undefined) patch.enforced = body.enforced === true;
  if (body.jit_provisioning_enabled !== undefined) {
    patch.jitProvisioningEnabled = body.jit_provisioning_enabled === true;
  }
  if (body.default_role !== undefined) {
    const defaultRole = parseDefaultRole(body.default_role);
    if (!defaultRole) return c.json({ error: 'default_role must be admin or member' }, 400);
    patch.defaultRole = defaultRole;
  }

  const row = await updateSsoConnection(accountId, c.req.param('connectionId'), patch);
  if (!row) return c.json({ error: 'SSO connection not found' }, 404);
  return c.json(serializeConnection(row));
});

accountSsoRouter.delete('/:accountId/security/sso/connections/:connectionId', async (c) => {
  const accountId = c.req.param('accountId');
  await requireSsoAdmin(c, accountId);
  const deleted = await deleteSsoConnection(accountId, c.req.param('connectionId'));
  if (!deleted) return c.json({ error: 'SSO connection not found' }, 404);
  return c.json({ deleted: true });
});
