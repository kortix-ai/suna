// SAML SSO data access. The Supabase auth.sso_providers row drives the
// SAML handshake itself; this module manages the kortix-side mapping —
// which account owns which provider, plus claim-value → IAM group rules.

import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import {
  accountSsoGroupMappings,
  accountSsoProviders,
  accountGroups,
} from '@kortix/db';
import { db } from '../shared/db';

export type SsoProvider = {
  ssoProviderId: string;
  accountId: string;
  supabaseSsoProviderId: string;
  name: string;
  primaryDomain: string;
  groupClaimName: string;
  autoCreateMembers: boolean;
  autoProvisionGroups: boolean;
  enforceSso: boolean;
  domainVerificationToken: string | null;
  domainVerifiedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SsoGroupMapping = {
  mappingId: string;
  accountId: string;
  ssoProviderId: string;
  claimValue: string;
  groupId: string;
  groupName: string;
  createdBy: string | null;
  createdAt: Date;
};

// ─── Provider ─────────────────────────────────────────────────────────────

export async function getSsoProvider(accountId: string): Promise<SsoProvider | null> {
  const [row] = await db
    .select()
    .from(accountSsoProviders)
    .where(eq(accountSsoProviders.accountId, accountId))
    .limit(1);
  return row ?? null;
}

/**
 * Reverse lookup used by auth middleware: given a Supabase sso_provider
 * UUID from a JWT, find which kortix account it belongs to.
 */
export async function getSsoProviderBySupabaseId(
  supabaseSsoProviderId: string,
): Promise<SsoProvider | null> {
  const [row] = await db
    .select()
    .from(accountSsoProviders)
    .where(eq(accountSsoProviders.supabaseSsoProviderId, supabaseSsoProviderId))
    .limit(1);
  return row ?? null;
}

/**
 * Domain lookup for the unified auth flow's `/access/check-email`: is this
 * email domain bound to a SAML provider, and does that org enforce SSO-only
 * sign-in? Domains are stored lowercase (see upsert below).
 *
 * `primary_domain` is not unique: any entitled admin can type any domain. A
 * provider whose account proved control of the domain wins over one that did
 * not, so an unverified claim can never shadow the real owner.
 */
export async function getSsoProviderByDomain(domain: string): Promise<SsoProvider | null> {
  const [row] = await db
    .select()
    .from(accountSsoProviders)
    .where(eq(accountSsoProviders.primaryDomain, domain.toLowerCase()))
    .orderBy(sql`${accountSsoProviders.domainVerifiedAt} asc nulls last`, asc(accountSsoProviders.createdAt))
    .limit(1);
  return row ?? null;
}

/** The lowercase domain part of an email address, or '' when there is none. */
export function emailDomain(email: string | null | undefined): string {
  const normalized = (email ?? '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return at > 0 ? normalized.slice(at + 1) : '';
}

/** True when the account proved control of the provider's primary domain. */
export function isSsoDomainVerified(provider: Pick<SsoProvider, 'domainVerifiedAt'> | null | undefined): boolean {
  return !!provider?.domainVerifiedAt;
}

/**
 * The SSO provider that enforces SSO-only sign-in for this email, or null.
 * `enforce_sso` applies only to a verified domain: an admin cannot lock other
 * people out of password sign-in by claiming a domain they do not control.
 */
export async function ssoEnforcedForEmail(email: string): Promise<SsoProvider | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const provider = await getSsoProviderByDomain(domain);
  return provider?.enforceSso && isSsoDomainVerified(provider) ? provider : null;
}

/** DNS name that carries the domain-verification TXT record. */
export function ssoDomainVerificationRecordName(domain: string): string {
  return `_kortix-verification.${domain.toLowerCase()}`;
}

/** TXT record value that proves control of the domain for this provider. */
export function ssoDomainVerificationRecordValue(token: string): string {
  return `kortix-verification=${token}`;
}

function newDomainVerificationToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Another account already proved control of this domain. Verification is
 * refused then: one domain has one authoritative IdP.
 */
export async function domainVerifiedByOtherAccount(accountId: string, domain: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accountSsoProviders.ssoProviderId })
    .from(accountSsoProviders)
    .where(
      and(
        eq(accountSsoProviders.primaryDomain, domain.toLowerCase()),
        isNotNull(accountSsoProviders.domainVerifiedAt),
        ne(accountSsoProviders.accountId, accountId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Record that the account controls its provider's primary domain (`verified`)
 * or withdraw that (`!verified`). Returns the updated provider, or null when
 * the account has none.
 */
export async function setSsoDomainVerified(accountId: string, verified: boolean): Promise<SsoProvider | null> {
  const [row] = await db
    .update(accountSsoProviders)
    .set({ domainVerifiedAt: verified ? new Date() : null, updatedAt: new Date() })
    .where(eq(accountSsoProviders.accountId, accountId))
    .returning();
  return row ?? null;
}

export async function upsertSsoProvider(args: {
  accountId: string;
  supabaseSsoProviderId: string;
  name: string;
  primaryDomain: string;
  groupClaimName?: string;
  autoCreateMembers?: boolean;
  autoProvisionGroups?: boolean;
  enforceSso?: boolean;
  createdBy: string;
}): Promise<SsoProvider> {
  const existing = await getSsoProvider(args.accountId);
  const primaryDomain = args.primaryDomain.toLowerCase();
  if (existing) {
    // A new domain is a new claim: it starts unverified, with a new challenge.
    const domainChanged = existing.primaryDomain !== primaryDomain;
    const [row] = await db
      .update(accountSsoProviders)
      .set({
        supabaseSsoProviderId: args.supabaseSsoProviderId,
        name: args.name,
        primaryDomain,
        ...(domainChanged
          ? { domainVerifiedAt: null, domainVerificationToken: newDomainVerificationToken() }
          : existing.domainVerificationToken
            ? {}
            : { domainVerificationToken: newDomainVerificationToken() }),
        groupClaimName: args.groupClaimName ?? existing.groupClaimName,
        autoCreateMembers: args.autoCreateMembers ?? existing.autoCreateMembers,
        autoProvisionGroups: args.autoProvisionGroups ?? existing.autoProvisionGroups,
        enforceSso: args.enforceSso ?? existing.enforceSso,
        updatedAt: new Date(),
      })
      .where(eq(accountSsoProviders.ssoProviderId, existing.ssoProviderId))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(accountSsoProviders)
    .values({
      accountId: args.accountId,
      supabaseSsoProviderId: args.supabaseSsoProviderId,
      name: args.name,
      primaryDomain,
      domainVerificationToken: newDomainVerificationToken(),
      groupClaimName: args.groupClaimName ?? 'groups',
      autoCreateMembers: args.autoCreateMembers ?? true,
      autoProvisionGroups: args.autoProvisionGroups ?? false,
      enforceSso: args.enforceSso ?? false,
      createdBy: args.createdBy,
    })
    .returning();
  return row;
}

export async function deleteSsoProvider(accountId: string): Promise<boolean> {
  const rows = await db
    .delete(accountSsoProviders)
    .where(eq(accountSsoProviders.accountId, accountId))
    .returning({ ssoProviderId: accountSsoProviders.ssoProviderId });
  return rows.length > 0;
}

// ─── Group mappings ───────────────────────────────────────────────────────

export async function listSsoGroupMappings(accountId: string): Promise<SsoGroupMapping[]> {
  // Join in the group name so the UI can render mappings without a
  // second round-trip to fetch group labels.
  const rows = await db
    .select({
      mappingId: accountSsoGroupMappings.mappingId,
      accountId: accountSsoGroupMappings.accountId,
      ssoProviderId: accountSsoGroupMappings.ssoProviderId,
      claimValue: accountSsoGroupMappings.claimValue,
      groupId: accountSsoGroupMappings.groupId,
      groupName: accountGroups.name,
      createdBy: accountSsoGroupMappings.createdBy,
      createdAt: accountSsoGroupMappings.createdAt,
    })
    .from(accountSsoGroupMappings)
    .innerJoin(accountGroups, eq(accountGroups.groupId, accountSsoGroupMappings.groupId))
    .where(eq(accountSsoGroupMappings.accountId, accountId))
    .orderBy(asc(accountSsoGroupMappings.claimValue));
  return rows;
}

export async function createSsoGroupMapping(args: {
  accountId: string;
  ssoProviderId: string;
  claimValue: string;
  groupId: string;
  createdBy: string;
}): Promise<SsoGroupMapping | null> {
  // Verify group belongs to the account first — guard against pointing
  // a mapping at a group from a different tenant.
  const [grp] = await db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(
      and(eq(accountGroups.accountId, args.accountId), eq(accountGroups.groupId, args.groupId)),
    )
    .limit(1);
  if (!grp) return null;

  const [row] = await db
    .insert(accountSsoGroupMappings)
    .values({
      accountId: args.accountId,
      ssoProviderId: args.ssoProviderId,
      claimValue: args.claimValue,
      groupId: args.groupId,
      createdBy: args.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  return { ...row, groupName: grp.name };
}

export async function deleteSsoGroupMapping(
  accountId: string,
  mappingId: string,
): Promise<boolean> {
  const rows = await db
    .delete(accountSsoGroupMappings)
    .where(
      and(
        eq(accountSsoGroupMappings.accountId, accountId),
        eq(accountSsoGroupMappings.mappingId, mappingId),
      ),
    )
    .returning({ mappingId: accountSsoGroupMappings.mappingId });
  return rows.length > 0;
}

/**
 * Auto-provision: ensure an IAM group + claim mapping exist for a group value
 * the IdP sent (used only when the provider has autoProvisionGroups on).
 *
 * Idempotent and rename-safe: if a mapping for this claim value already exists
 * we return its group and touch nothing — so an admin renaming the
 * auto-created group won't spawn a duplicate on the next login, and manual
 * mappings win. Otherwise find-or-create a group named after the claim value
 * (source 'sso') and map the claim to it. Returns the resolved groupId, or null
 * if the value is empty / the group couldn't be created.
 */
export async function ensureAutoProvisionedGroup(args: {
  accountId: string;
  ssoProviderId: string;
  claimValue: string;
}): Promise<string | null> {
  const claimValue = args.claimValue.trim();
  if (!claimValue) return null;

  const [mapped] = await db
    .select({ groupId: accountSsoGroupMappings.groupId })
    .from(accountSsoGroupMappings)
    .where(
      and(
        eq(accountSsoGroupMappings.accountId, args.accountId),
        eq(accountSsoGroupMappings.claimValue, claimValue),
      ),
    )
    .limit(1);
  if (mapped) return mapped.groupId;

  // Find-or-create the group (unique on account+name). On a name collision
  // the insert no-ops via onConflictDoNothing — the fallback lookup MUST
  // stay scoped to source='sso' so we can never adopt a pre-existing
  // MANUAL (possibly privileged) group just because an admin happened to
  // name it the same as an incoming IdP claim value. If no sso-sourced
  // group exists after the conflict, we skip provisioning for this claim
  // rather than annex the manual one.
  const [created] = await db
    .insert(accountGroups)
    .values({
      accountId: args.accountId,
      name: claimValue,
      source: 'sso',
      description: 'Auto-provisioned from an SSO group claim.',
    })
    .onConflictDoNothing()
    .returning({ groupId: accountGroups.groupId });
  let groupId = created?.groupId;
  if (!groupId) {
    const [existing] = await db
      .select({ groupId: accountGroups.groupId })
      .from(accountGroups)
      .where(
        and(
          eq(accountGroups.accountId, args.accountId),
          eq(accountGroups.name, claimValue),
          eq(accountGroups.source, 'sso'),
        ),
      )
      .limit(1);
    groupId = existing?.groupId;
  }
  if (!groupId) return null;

  await db
    .insert(accountSsoGroupMappings)
    .values({
      accountId: args.accountId,
      ssoProviderId: args.ssoProviderId,
      claimValue,
      groupId,
    })
    .onConflictDoNothing();
  return groupId;
}
