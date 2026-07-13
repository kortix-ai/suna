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

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accountGroupMembers, accountInvitations, accountMembers } from '@kortix/db';
import { db } from '../shared/db';
import { invalidateIamCacheForUser } from './cache-invalidation';
import {
  ensureAutoProvisionedGroup,
  getSsoProviderBySupabaseId,
  listSsoGroupMappings,
} from '../repositories/sso';

interface SsoSyncOutcome {
  /** No SAML provider id on this JWT — sync skipped. */
  skipped: boolean;
  /** True when this run created the account_members row. */
  memberCreated?: boolean;
  /** Groups added/removed this run. Empty when no diff. */
  groupsAdded?: string[];
  groupsRemoved?: string[];
}

/** Pull the auth `sso_providers` id out of a Supabase `"sso:<uuid>"` tag. */
function ssoIdFromProviderTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const prefix = 'sso:';
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Extract the Supabase `sso_providers` id from a JWT payload, or null when the
 * token isn't a SAML login.
 *
 * Real Supabase SAML tokens carry the id INSIDE `app_metadata.provider` (and
 * `app_metadata.providers[]`) as the string `"sso:<uuid>"`, e.g.
 * `provider: "sso:464651b7-6157-46b1-afaa-5bbd7fa37599"`. We also accept a bare
 * `sso_provider_id`/`provider_id` for forward-compat and simpler test fixtures.
 *
 * The previous implementation read ONLY the bare fields, which no real Supabase
 * SAML token sets — so `extractSsoProviderId` always returned null and NO SSO
 * user was ever JIT-provisioned into their org (they fell through to a personal
 * account instead). Parsing the `"sso:<uuid>"` tag is the actual fix.
 */
export function extractSsoProviderId(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload) return null;
  const meta = payload.app_metadata as Record<string, unknown> | undefined;
  if (!meta) return null;

  // Explicit fields first (forward-compat / fixtures).
  const explicit = meta.sso_provider_id ?? meta.provider_id;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  // Real shape: provider = "sso:<uuid>", providers = ["sso:<uuid>"].
  const fromProvider = ssoIdFromProviderTag(meta.provider);
  if (fromProvider) return fromProvider;
  if (Array.isArray(meta.providers)) {
    for (const p of meta.providers) {
      const id = ssoIdFromProviderTag(p);
      if (id) return id;
    }
  }
  return null;
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
  const asObj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  const app = asObj(payload.app_metadata);
  const user = asObj(payload.user_metadata);
  // Supabase SSO nests the mapped SAML attributes under
  // `user_metadata.custom_claims` (e.g. `custom_claims.groups`) — NOT at the top
  // of user_metadata — so check custom_claims FIRST, then fall back to the flat
  // locations other IdPs / non-SSO tokens use.
  const sources: Array<Record<string, unknown> | undefined> = [
    asObj(user?.custom_claims),
    asObj(app?.custom_claims),
    app,
    user,
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
 * Resolve which Kortix group ids a set of IdP claim values map to. Pure —
 * exported for unit tests.
 *
 * Matching is CASE- and whitespace-INSENSITIVE: Azure AD / Entra emits group
 * values (display names or `sAMAccountName`) whose casing an admin can easily
 * mistype when creating the mapping, and a silent case mismatch would deny a
 * user their groups with no error. Object-ID (GUID) values are unaffected —
 * lowercasing a GUID still matches. Both sides are normalized identically.
 */
export function resolveClaimedGroupIds(
  claims: readonly string[],
  mappings: ReadonlyArray<{ claimValue: string; groupId: string }>,
): Set<string> {
  const norm = (v: string) => v.trim().toLowerCase();
  const claimSet = new Set(claims.map(norm));
  const ids = new Set<string>();
  for (const m of mappings) {
    if (claimSet.has(norm(m.claimValue))) ids.add(m.groupId);
  }
  return ids;
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
// Bare UUID check — deliberately local; the full validator lives in the
// invites router module, and lib code shouldn't import a router for it.
const GROUP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply SCIM group memberships that were parked on a pending invite for this
 * email (see scim/groups.ts addGroupMembersOrDeferInvites). JIT auto-create
 * bypasses the invite-acceptance flow, so without this the parked entries
 * strand forever. Applies + strips only the `{group_id}` entries; project
 * grants stay on the (still pending) invite for the real accept flow.
 * Best-effort — a failure here must not block sign-in.
 */
async function consumeInviteGroupGrants(
  accountId: string,
  userId: string,
  email: string,
): Promise<void> {
  try {
    const [invite] = await db
      .select({
        inviteId: accountInvitations.inviteId,
        bootstrapGrants: accountInvitations.bootstrapGrants,
      })
      .from(accountInvitations)
      .where(
        and(
          eq(accountInvitations.accountId, accountId),
          sql`lower(${accountInvitations.email}) = lower(${email})`,
          isNull(accountInvitations.acceptedAt),
        ),
      )
      .limit(1);
    if (!invite) return;

    const grants = invite.bootstrapGrants ?? [];
    const groupIds = grants
      .filter((g): g is { group_id: string } => 'group_id' in g && typeof g.group_id === 'string')
      .map((g) => g.group_id)
      .filter((id) => GROUP_UUID_RE.test(id));
    if (groupIds.length === 0) return;

    await db
      .insert(accountGroupMembers)
      .values(groupIds.map((groupId) => ({ groupId, userId })))
      .onConflictDoNothing();

    const remaining = grants.filter((g) => !('group_id' in g));
    await db
      .update(accountInvitations)
      .set({ bootstrapGrants: remaining })
      .where(eq(accountInvitations.inviteId, invite.inviteId));
  } catch (err) {
    console.warn('[sso-sync] failed to consume parked invite group grants', {
      accountId,
      userId,
      err,
    });
  }
}

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
    // JIT bypasses invite acceptance, so SCIM group memberships parked on a
    // pending invite for this email (scim/groups.ts) would strand forever —
    // consume them now. Project grants on the invite stay for the real
    // accept flow; only the {group_id} entries are applied and stripped.
    await consumeInviteGroupGrants(provider.accountId, args.userId, args.email);
  }

  // 2. Sync IAM group memberships from the claim.
  const claims = extractGroupClaims(args.jwtPayload, provider.groupClaimName);

  // Auto-provision: when enabled, create an IAM group + mapping for every
  // (deduped) group the IdP sent BEFORE reading the mappings below, so the
  // freshly created ones flow through the very same diff — the admin skips
  // hand-mapping each group and just attaches project roles to the new ones.
  if (provider.autoProvisionGroups) {
    for (const claimValue of new Set(claims)) {
      await ensureAutoProvisionedGroup({
        accountId: provider.accountId,
        ssoProviderId: provider.ssoProviderId,
        claimValue,
      });
    }
  }

  const mappings = await listSsoGroupMappings(provider.accountId);
  if (mappings.length === 0) {
    return { skipped: false, memberCreated };
  }
  const claimedGroupIds = resolveClaimedGroupIds(claims, mappings);
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

  // JIT membership changed on login → bust this user so their group-derived
  // roles are correct on the very first authed request of the session.
  if (memberCreated || toAdd.length > 0 || toRemove.length > 0) {
    invalidateIamCacheForUser(args.userId);
  }

  return {
    skipped: false,
    memberCreated,
    groupsAdded: toAdd,
    groupsRemoved: toRemove,
  };
}
