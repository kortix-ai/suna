// SAML SSO data access. The Supabase auth.sso_providers row drives the
// SAML handshake itself; this module manages the kortix-side mapping —
// which account owns which provider, plus claim-value → IAM group rules.

import { and, asc, eq } from 'drizzle-orm';
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

export async function upsertSsoProvider(args: {
  accountId: string;
  supabaseSsoProviderId: string;
  name: string;
  primaryDomain: string;
  groupClaimName?: string;
  autoCreateMembers?: boolean;
  autoProvisionGroups?: boolean;
  createdBy: string;
}): Promise<SsoProvider> {
  const existing = await getSsoProvider(args.accountId);
  if (existing) {
    const [row] = await db
      .update(accountSsoProviders)
      .set({
        supabaseSsoProviderId: args.supabaseSsoProviderId,
        name: args.name,
        primaryDomain: args.primaryDomain.toLowerCase(),
        groupClaimName: args.groupClaimName ?? existing.groupClaimName,
        autoCreateMembers: args.autoCreateMembers ?? existing.autoCreateMembers,
        autoProvisionGroups: args.autoProvisionGroups ?? existing.autoProvisionGroups,
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
      primaryDomain: args.primaryDomain.toLowerCase(),
      groupClaimName: args.groupClaimName ?? 'groups',
      autoCreateMembers: args.autoCreateMembers ?? true,
      autoProvisionGroups: args.autoProvisionGroups ?? false,
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
