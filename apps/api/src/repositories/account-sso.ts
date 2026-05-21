import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { and, asc, eq } from 'drizzle-orm';
import {
  accountMembers,
  accountSsoConnections,
  accountVerifiedDomains,
  accounts,
} from '@kortix/db';
import { db } from '../shared/db';

export type AccountRole = 'owner' | 'admin' | 'member';
export type SsoProtocol = 'saml' | 'oidc';
export type SsoConnectionStatus = 'active' | 'disabled';
export type VerifiedDomainStatus = 'pending' | 'verified';

export interface DomainSsoPolicy {
  domain: string;
  ssoAvailable: boolean;
  ssoRequired: boolean;
  providerId: string | null;
  providerName: string | null;
  protocol: SsoProtocol | null;
  accountId: string | null;
  accountName: string | null;
  jitProvisioningEnabled: boolean;
  defaultRole: AccountRole;
}

export function normalizeSsoDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const domain = raw.includes('@') ? raw.split('@').pop() || '' : raw;
  if (!domain || domain.length > 255) return null;
  if (domain.includes('/') || domain.includes(':') || domain.includes(' ')) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  return domain;
}

export function ssoVerificationTxtValue(token: string): string {
  return `kortix-sso-verification=${token}`;
}

export function isSsoAuthProvider(provider: unknown): boolean {
  if (Array.isArray(provider)) return provider.some((item) => isSsoAuthProvider(item));
  if (typeof provider !== 'string') return false;
  const normalized = provider.toLowerCase();
  return normalized === 'sso' || normalized === 'saml' || normalized.includes('saml');
}

export function generateSsoVerificationToken(): string {
  return randomBytes(24).toString('hex');
}

export async function listAccountSsoSettings(accountId: string) {
  const [domains, connections] = await Promise.all([
    db
      .select()
      .from(accountVerifiedDomains)
      .where(eq(accountVerifiedDomains.accountId, accountId))
      .orderBy(asc(accountVerifiedDomains.domain)),
    db
      .select()
      .from(accountSsoConnections)
      .where(eq(accountSsoConnections.accountId, accountId))
      .orderBy(asc(accountSsoConnections.createdAt)),
  ]);

  return { domains, connections };
}

export async function createVerifiedDomain(args: {
  accountId: string;
  domain: string;
  createdBy: string;
}) {
  const domain = normalizeSsoDomain(args.domain);
  if (!domain) throw new Error('invalid_domain');
  const [row] = await db
    .insert(accountVerifiedDomains)
    .values({
      accountId: args.accountId,
      domain,
      verificationToken: generateSsoVerificationToken(),
      createdBy: args.createdBy,
    })
    .returning();
  return row;
}

export async function deleteVerifiedDomain(accountId: string, domainId: string): Promise<boolean> {
  const rows = await db
    .delete(accountVerifiedDomains)
    .where(and(
      eq(accountVerifiedDomains.accountId, accountId),
      eq(accountVerifiedDomains.domainId, domainId),
    ))
    .returning({ domainId: accountVerifiedDomains.domainId });
  return rows.length > 0;
}

export async function verifyDomainDns(accountId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(accountVerifiedDomains)
    .where(and(
      eq(accountVerifiedDomains.accountId, accountId),
      eq(accountVerifiedDomains.domainId, domainId),
    ))
    .limit(1);
  if (!domain) return { ok: false as const, reason: 'not_found' };

  const expected = ssoVerificationTxtValue(domain.verificationToken);
  let records: string[] = [];
  try {
    const txt = await resolveTxt(domain.domain);
    records = txt.map((parts) => parts.join(''));
  } catch {
    records = [];
  }

  if (!records.includes(expected)) {
    return {
      ok: false as const,
      reason: 'txt_missing',
      expected,
      records,
    };
  }

  const [updated] = await db
    .update(accountVerifiedDomains)
    .set({ status: 'verified', verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(accountVerifiedDomains.accountId, accountId),
      eq(accountVerifiedDomains.domainId, domainId),
    ))
    .returning();

  return { ok: true as const, domain: updated };
}

export async function createSsoConnection(args: {
  accountId: string;
  providerId: string;
  providerName?: string | null;
  protocol?: SsoProtocol;
  enforced?: boolean;
  jitProvisioningEnabled?: boolean;
  defaultRole?: AccountRole;
  createdBy: string;
}) {
  const [row] = await db
    .insert(accountSsoConnections)
    .values({
      accountId: args.accountId,
      providerId: args.providerId,
      providerName: args.providerName ?? null,
      protocol: args.protocol ?? 'saml',
      enforced: args.enforced ?? false,
      jitProvisioningEnabled: args.jitProvisioningEnabled ?? true,
      defaultRole: args.defaultRole ?? 'member',
      createdBy: args.createdBy,
    })
    .returning();
  return row;
}

export async function updateSsoConnection(
  accountId: string,
  connectionId: string,
  patch: {
    providerId?: string;
    providerName?: string | null;
    protocol?: SsoProtocol;
    status?: SsoConnectionStatus;
    enforced?: boolean;
    jitProvisioningEnabled?: boolean;
    defaultRole?: AccountRole;
  },
) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.providerId !== undefined) updates.providerId = patch.providerId;
  if (patch.providerName !== undefined) updates.providerName = patch.providerName;
  if (patch.protocol !== undefined) updates.protocol = patch.protocol;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.enforced !== undefined) updates.enforced = patch.enforced;
  if (patch.jitProvisioningEnabled !== undefined) {
    updates.jitProvisioningEnabled = patch.jitProvisioningEnabled;
  }
  if (patch.defaultRole !== undefined) updates.defaultRole = patch.defaultRole;

  const [row] = await db
    .update(accountSsoConnections)
    .set(updates)
    .where(and(
      eq(accountSsoConnections.accountId, accountId),
      eq(accountSsoConnections.connectionId, connectionId),
    ))
    .returning();
  return row ?? null;
}

export async function deleteSsoConnection(accountId: string, connectionId: string): Promise<boolean> {
  const rows = await db
    .delete(accountSsoConnections)
    .where(and(
      eq(accountSsoConnections.accountId, accountId),
      eq(accountSsoConnections.connectionId, connectionId),
    ))
    .returning({ connectionId: accountSsoConnections.connectionId });
  return rows.length > 0;
}

export async function resolveSsoPolicyForDomain(input: string): Promise<DomainSsoPolicy> {
  const domain = normalizeSsoDomain(input);
  if (!domain) {
    return {
      domain: '',
      ssoAvailable: false,
      ssoRequired: false,
      providerId: null,
      providerName: null,
      protocol: null,
      accountId: null,
      accountName: null,
      jitProvisioningEnabled: false,
      defaultRole: 'member',
    };
  }

  const [row] = await db
    .select({
      domain: accountVerifiedDomains.domain,
      accountId: accounts.accountId,
      accountName: accounts.name,
      providerId: accountSsoConnections.providerId,
      providerName: accountSsoConnections.providerName,
      protocol: accountSsoConnections.protocol,
      enforced: accountSsoConnections.enforced,
      jitProvisioningEnabled: accountSsoConnections.jitProvisioningEnabled,
      defaultRole: accountSsoConnections.defaultRole,
    })
    .from(accountVerifiedDomains)
    .innerJoin(accounts, eq(accounts.accountId, accountVerifiedDomains.accountId))
    .innerJoin(accountSsoConnections, eq(accountSsoConnections.accountId, accounts.accountId))
    .where(and(
      eq(accountVerifiedDomains.domain, domain),
      eq(accountVerifiedDomains.status, 'verified'),
      eq(accountSsoConnections.status, 'active'),
    ))
    .limit(1);

  if (!row) {
    return {
      domain,
      ssoAvailable: false,
      ssoRequired: false,
      providerId: null,
      providerName: null,
      protocol: null,
      accountId: null,
      accountName: null,
      jitProvisioningEnabled: false,
      defaultRole: 'member',
    };
  }

  return {
    domain: row.domain,
    ssoAvailable: true,
    ssoRequired: row.enforced,
    providerId: row.providerId,
    providerName: row.providerName,
    protocol: row.protocol as SsoProtocol,
    accountId: row.accountId,
    accountName: row.accountName,
    jitProvisioningEnabled: row.jitProvisioningEnabled,
    defaultRole: row.defaultRole as AccountRole,
  };
}

export async function maybeJitProvisionSsoUser(args: {
  userId: string;
  email: string;
  authProvider: unknown;
}) {
  if (!isSsoAuthProvider(args.authProvider)) return null;
  const policy = await resolveSsoPolicyForDomain(args.email);
  if (!policy.ssoAvailable || !policy.jitProvisioningEnabled || !policy.accountId) return null;

  const [existing] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(
      eq(accountMembers.userId, args.userId),
      eq(accountMembers.accountId, policy.accountId),
    ))
    .limit(1);
  if (existing) {
    return { created: false, accountId: policy.accountId, accountRole: policy.defaultRole };
  }

  await db
    .insert(accountMembers)
    .values({
      userId: args.userId,
      accountId: policy.accountId,
      accountRole: policy.defaultRole,
    })
    .onConflictDoNothing();

  return { created: true, accountId: policy.accountId, accountRole: policy.defaultRole };
}
