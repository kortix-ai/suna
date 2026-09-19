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

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accountMemberships, accountScimUsers } from '@kortix/db';
import { db } from '../shared/db';
import { withDirectoryTransaction } from './directory-transaction';
import { assignRole, SYSTEM_ACTOR } from './assignments';
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
 * Move one account-scoped person from a legacy Auth id to the Auth id emitted
 * by the account's SAML provider. The active SCIM row is the trusted link:
 * account + normalized email identify the person; the SAML subject supplies
 * the current login id. Historical audit actors remain unchanged.
 */
async function reconcileDirectoryIdentity(
  accountId: string,
  oldUserId: string,
  ssoUserId: string,
): Promise<void> {
  if (oldUserId === ssoUserId) return;

  await db.execute(sql`
    INSERT INTO kortix.account_memberships (user_id, account_id, joined_at, is_super_admin, scim_external_id)
    SELECT ${ssoUserId}::uuid, account_id, joined_at, is_super_admin, scim_external_id
    FROM kortix.account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid
    ON CONFLICT (user_id, account_id) DO UPDATE SET
      joined_at=least(kortix.account_memberships.joined_at, excluded.joined_at),
      is_super_admin=kortix.account_memberships.is_super_admin OR excluded.is_super_admin,
      scim_external_id=coalesce(excluded.scim_external_id, kortix.account_memberships.scim_external_id)
  `);
  await db.execute(sql`
    INSERT INTO kortix.group_members (group_id, user_id, added_by, added_at)
    SELECT gm.group_id, ${ssoUserId}::uuid, gm.added_by, gm.added_at
    FROM kortix.group_members gm
    JOIN kortix.account_groups g ON g.group_id=gm.group_id
    WHERE g.account_id=${accountId}::uuid AND gm.user_id=${oldUserId}::uuid
    ON CONFLICT (group_id, user_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.role_assignments old USING kortix.role_assignments newer
    WHERE old.account_id=${accountId}::uuid
      AND old.principal_type='user' AND old.principal_id=${oldUserId}::uuid
      AND newer.account_id=old.account_id AND newer.principal_type='user'
      AND newer.principal_id=${ssoUserId}::uuid AND newer.role_id=old.role_id
      AND newer.scope_type=old.scope_type AND newer.scope_id IS NOT DISTINCT FROM old.scope_id
      AND newer.object_type IS NOT DISTINCT FROM old.object_type
      AND newer.object_id IS NOT DISTINCT FROM old.object_id
  `);
  await db.execute(sql`
    UPDATE kortix.role_assignments SET principal_id=${ssoUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND principal_type='user' AND principal_id=${oldUserId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO kortix.project_session_grants (session_id, principal_type, principal_id, created_at)
    SELECT g.session_id, g.principal_type, ${ssoUserId}::uuid, g.created_at
    FROM kortix.project_session_grants g
    JOIN kortix.project_sessions s ON s.session_id=g.session_id
    WHERE s.account_id=${accountId}::uuid AND g.principal_type='member' AND g.principal_id=${oldUserId}::uuid
    ON CONFLICT (session_id, principal_type, principal_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.project_session_grants g USING kortix.project_sessions s
    WHERE s.session_id=g.session_id AND s.account_id=${accountId}::uuid
      AND g.principal_type='member' AND g.principal_id=${oldUserId}::uuid
  `);
  await db.execute(sql`UPDATE kortix.project_sessions SET created_by=${ssoUserId}::uuid WHERE account_id=${accountId}::uuid AND created_by=${oldUserId}::uuid`);
  // Session tokens belong to their sessions and follow the session owner. A
  // standalone PAT is an old login credential; revoke it instead of silently
  // rebinding it to the new SSO identity.
  await db.execute(sql`
    UPDATE kortix.account_tokens SET status='revoked', revoked_at=coalesce(revoked_at, now())
    WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid AND session_id IS NULL AND status='active'
  `);
  await db.execute(sql`
    UPDATE kortix.account_tokens SET user_id=${ssoUserId}::uuid
    WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid AND session_id IS NOT NULL
  `);
  await db.execute(sql`UPDATE kortix.project_session_public_shares SET created_by=${ssoUserId}::uuid WHERE account_id=${accountId}::uuid AND created_by=${oldUserId}::uuid`);
  await db.execute(sql`UPDATE kortix.account_github_installation_states SET user_id=${ssoUserId}::uuid WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid`);
  await db.execute(sql`
    DELETE FROM kortix.group_members gm USING kortix.account_groups g
    WHERE g.group_id=gm.group_id AND g.account_id=${accountId}::uuid AND gm.user_id=${oldUserId}::uuid
  `);
  await db.execute(sql`DELETE FROM kortix.account_memberships WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid`);
  await db.execute(sql`
    UPDATE kortix.account_scim_users SET user_id=${ssoUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND user_id=${oldUserId}::uuid
  `);
  invalidateIamCacheForUser(oldUserId);
  invalidateIamCacheForUser(ssoUserId);
}

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

    // A parked group may have been deleted since parking; its id would FK-fail
    // the WHOLE batch insert and lose the healthy grants with it. Keep only
    // groups that still exist — scoped to this account, which also stops a
    // grant from ever landing in another account's group.
    const liveGroups = await db
      .select({ groupId: accountGroups.groupId })
      .from(accountGroups)
      .where(and(eq(accountGroups.accountId, accountId), inArray(accountGroups.groupId, groupIds)));
    if (liveGroups.length > 0) {
      await db
        .insert(accountGroupMembers)
        .values(liveGroups.map(({ groupId }) => ({ groupId, userId })))
        .onConflictDoNothing();
    }

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

  return withDirectoryTransaction(provider.accountId, async () => {
    const [directoryUser] = await db.select().from(accountScimUsers).where(and(
      eq(accountScimUsers.accountId, provider.accountId),
      or(eq(accountScimUsers.userId, args.userId), eq(accountScimUsers.userName, args.email.trim().toLowerCase())),
    )).limit(1);
    if (directoryUser && (!directoryUser.active || directoryUser.deletedAt)) {
      return { skipped: false, memberCreated: false };
    }
    const emailMembers = await db.execute(sql`
      SELECT membership.user_id::text AS user_id
      FROM kortix.account_memberships membership
      JOIN auth.users auth_user ON auth_user.id=membership.user_id
      WHERE membership.account_id=${provider.accountId}::uuid
        AND lower(auth_user.email)=lower(${args.email.trim()})
        AND membership.user_id<>${args.userId}::uuid
      ORDER BY membership.joined_at, membership.user_id
    `) as unknown as Array<{ user_id: string }>;
    const candidateIds = new Set([
      ...(directoryUser?.userId && directoryUser.userId !== args.userId ? [directoryUser.userId] : []),
      ...emailMembers.map(row => row.user_id),
    ]);
    if (candidateIds.size > 1) {
      throw new Error(`Ambiguous account identity for ${args.email.trim().toLowerCase()}`);
    }
    const priorUserId = [...candidateIds][0];
    const identityReconciled = Boolean(priorUserId);
    if (priorUserId) {
      await reconcileDirectoryIdentity(provider.accountId, priorUserId, args.userId);
    } else if (directoryUser && !directoryUser.userId) {
      await db.update(accountScimUsers).set({ userId: args.userId })
        .where(and(eq(accountScimUsers.accountId, provider.accountId), eq(accountScimUsers.scimId, directoryUser.scimId)));
    }

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

    let memberCreated = identityReconciled;
    if (!existingMember) {
      if (!provider.autoCreateMembers && !directoryUser?.active) {
        return { skipped: false, memberCreated: false };
      }
      // IDENTITY, then the ROLE. Two stores since the cutover.
      await db
        .insert(accountMemberships)
        .values({ accountId: provider.accountId, userId: args.userId })
        .onConflictDoNothing();
      // The ROLE, through the ONE write path. SAML users default to `member`; real
      // privileges come from the group mappings below.
      //
      // SSO JIT keeps bypassing user-authz by design — an IdP is not a user, and
      // this runs inside the auth middleware where there is no caller to
      // authorize — but it does not bypass the audit trail or the cache contract:
      // `SYSTEM_ACTOR` skips only `assertWriterMayAssign`, and `source: 'sso'`
      // records WHY the row exists, so an admin reading the assignment can tell an
      // IdP-provisioned membership from one a human granted.
      //
      // Still best-effort: this runs inside the auth middleware on EVERY SAML
      // request, and a grant-store hiccup must not turn into a failed login. The
      // identity row above is what makes the person a member; a missing assignment
      // is re-created on their next request.
      try {
        await assignRole(SYSTEM_ACTOR, provider.accountId, {
          principal: { type: 'user', id: args.userId },
          roleKey: 'member',
          scope: { type: 'account' },
          source: 'sso',
          exclusive: true,
        });
      } catch (err) {
        console.warn('[sso-sync] canonical membership assignment failed', {
          accountId: provider.accountId,
          userId: args.userId,
          err: (err as Error)?.message,
        });
      }
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

    const allMappings = await listSsoGroupMappings(provider.accountId);
    const ssoGroups = await db.select({ groupId: accountGroups.groupId })
      .from(accountGroups)
      .where(and(eq(accountGroups.accountId, provider.accountId), ne(accountGroups.source, 'scim')));
    const ssoGroupIds = new Set(ssoGroups.map((group) => group.groupId));
    const mappings = allMappings.filter((mapping) => ssoGroupIds.has(mapping.groupId));
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
  });
}
