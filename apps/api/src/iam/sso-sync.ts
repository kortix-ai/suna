// SAML JIT (just-in-time) provisioning. Called from the auth middleware
// once per request, but no-ops cheaply unless the JWT carries a SAML
// sso_provider_id and that id is mapped to a kortix account.
//
// Responsibilities:
//   1. Ensure the user has an account_members row in that account.
//   2. Sync their IAM group memberships from the configured group claim:
//        - add groups that match claim values but aren't joined yet
//        - drop groups that are joined ONLY via this SSO connection but
//          whose claim has been removed.
//
// Manual group memberships (added by an admin in the UI) are preserved —
// we only touch groups that have a claim mapping. That keeps "this user
// also needs access to project X for a one-off" workable without the
// next sign-in stomping it.

import { and, eq, inArray } from 'drizzle-orm';
import { accountGroupMembers, accountMembers } from '@kortix/db';
import { db } from '../shared/db';
import {
  getSsoProviderBySupabaseId,
  listSsoGroupMappings,
} from '../repositories/sso';

export interface SsoSyncOutcome {
  /** No SAML provider id on this JWT — sync skipped. */
  skipped: boolean;
  /** True when this run created the account_members row. */
  memberCreated?: boolean;
  /** Groups added/removed this run. Empty when no diff. */
  groupsAdded?: string[];
  groupsRemoved?: string[];
}

/**
 * Extract the supabase sso_provider id from a JWT payload. Supabase puts
 * it in `app_metadata.provider_id` when the user signed in via SAML.
 */
export function extractSsoProviderId(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload) return null;
  const meta = payload.app_metadata as Record<string, unknown> | undefined;
  if (!meta) return null;
  // Supabase historically used `provider_id`; newer versions also set
  // `sso_provider_id`. Accept either so we're forward-compat.
  const id = meta.sso_provider_id ?? meta.provider_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Read a group claim out of the JWT. The claim name is configurable per
 * account; we accept string OR string[] (different IdPs ship either).
 */
export function extractGroupClaims(
  payload: Record<string, unknown> | undefined,
  claimName: string,
): string[] {
  if (!payload) return [];
  // Try app_metadata first (Supabase wraps SAML attributes there), then
  // the top level for IdPs that don't.
  const sources: Array<Record<string, unknown> | undefined> = [
    payload.app_metadata as Record<string, unknown> | undefined,
    payload.user_metadata as Record<string, unknown> | undefined,
    payload,
  ];
  for (const src of sources) {
    if (!src) continue;
    const raw = src[claimName];
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) {
      return raw.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

/**
 * Decide what to add/remove based on the claims a user presented vs the
 * mapped groups they currently belong to. Pure — exported for unit tests.
 *
 *   - currentGroupIds: groups the user already belongs to in this account
 *   - mappedGroupIds:  groups that are TARGETS of any SSO mapping
 *   - claimedGroupIds: groups the JWT's claims map to
 *
 * Returns:
 *   - toAdd: claimed but not currently joined
 *   - toRemove: currently joined AND mapped (so SSO owns them) but no
 *     longer claimed. Manually-added groups (currently joined but NOT
 *     in mappedGroupIds) are preserved.
 */
export function diffSsoGroups(args: {
  currentGroupIds: ReadonlySet<string>;
  mappedGroupIds: ReadonlySet<string>;
  claimedGroupIds: ReadonlySet<string>;
}): { toAdd: string[]; toRemove: string[] } {
  const toAdd: string[] = [];
  for (const id of args.claimedGroupIds) {
    if (!args.currentGroupIds.has(id)) toAdd.push(id);
  }
  const toRemove: string[] = [];
  for (const id of args.currentGroupIds) {
    if (args.mappedGroupIds.has(id) && !args.claimedGroupIds.has(id)) {
      toRemove.push(id);
    }
  }
  return { toAdd, toRemove };
}

/**
 * Main entry — call once per authenticated request from the middleware.
 * Cheap when the JWT isn't a SAML token (one early `if` and we return).
 */
export async function syncSsoMembership(args: {
  userId: string;
  email: string;
  jwtPayload: Record<string, unknown> | undefined;
}): Promise<SsoSyncOutcome> {
  const supabaseSsoProviderId = extractSsoProviderId(args.jwtPayload);
  if (!supabaseSsoProviderId) return { skipped: true };

  const provider = await getSsoProviderBySupabaseId(supabaseSsoProviderId);
  if (!provider) return { skipped: true };

  // 1. Ensure account membership. If autoCreateMembers is off, we only
  //    sync groups for users an admin has already invited.
  const [existingMember] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, provider.accountId),
        eq(accountMembers.userId, args.userId),
      ),
    )
    .limit(1);

  let memberCreated = false;
  if (!existingMember) {
    if (!provider.autoCreateMembers) {
      return { skipped: false, memberCreated: false };
    }
    await db
      .insert(accountMembers)
      .values({
        accountId: provider.accountId,
        userId: args.userId,
        // SAML users default to 'member' — the IAM engine grants nothing
        // off this alone (strict mode safe) and only reads under the
        // legacy bridge. Real privileges come from group mappings.
        accountRole: 'member',
      })
      .onConflictDoNothing();
    memberCreated = true;
  }

  // 2. Sync IAM group memberships from the claim.
  const mappings = await listSsoGroupMappings(provider.accountId);
  if (mappings.length === 0) {
    return { skipped: false, memberCreated };
  }

  const claims = extractGroupClaims(args.jwtPayload, provider.groupClaimName);
  const claimSet = new Set(claims);
  const claimedGroupIds = new Set(
    mappings.filter((m) => claimSet.has(m.claimValue)).map((m) => m.groupId),
  );
  const mappedGroupIds = new Set(mappings.map((m) => m.groupId));

  // Current memberships in this account, restricted to the mapped set
  // so we don't even consider stripping manual groups.
  const currentRows = mappedGroupIds.size === 0
    ? []
    : await db
        .select({ groupId: accountGroupMembers.groupId })
        .from(accountGroupMembers)
        .where(
          and(
            eq(accountGroupMembers.userId, args.userId),
            inArray(accountGroupMembers.groupId, [...mappedGroupIds]),
          ),
        );
  const currentGroupIds = new Set(currentRows.map((r) => r.groupId));

  const { toAdd, toRemove } = diffSsoGroups({
    currentGroupIds,
    mappedGroupIds,
    claimedGroupIds,
  });

  if (toAdd.length > 0) {
    await db
      .insert(accountGroupMembers)
      .values(
        toAdd.map((groupId) => ({
          groupId,
          userId: args.userId,
          addedBy: null,
        })),
      )
      .onConflictDoNothing();
  }
  if (toRemove.length > 0) {
    await db
      .delete(accountGroupMembers)
      .where(
        and(
          eq(accountGroupMembers.userId, args.userId),
          inArray(accountGroupMembers.groupId, toRemove),
        ),
      );
  }

  return {
    skipped: false,
    memberCreated,
    groupsAdded: toAdd,
    groupsRemoved: toRemove,
  };
}
