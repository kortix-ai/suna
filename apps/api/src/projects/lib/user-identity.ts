import { and, eq, inArray, sql } from 'drizzle-orm';
import { serviceAccounts } from '@kortix/db';
import { db } from '../../shared/db';
import {
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
} from '../../shared/impersonation';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { getSupabase } from '../../shared/supabase';
import { ttlMemo } from '../../shared/ttl-memo';
import { isUuid } from '../../shared/validate';
import { registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { accountRoleFor } from '../../iam/read-models';
import { mergeSessionOwnerIdentities, type SessionOwnerIdentity } from './session-inventory';

export interface UserIdentity {
  /** Email from the auth provider, or null if the user has none. */
  email: string | null;
  /** Best available display name from auth metadata. */
  displayName: string | null;
  /**
   * Whether this user_id resolves to a real auth user. `false` means the auth
   * provider returned NO user for this id — i.e. it's a shadow/orphan principal
   * (e.g. an `account_members` row whose user_id is actually an account_id with
   * no backing user). A transient lookup failure leaves this `true` so a hiccup
   * never hides a real member.
   */
  exists: boolean;
}

/**
 * Resolve user_ids to their auth identity (email + existence). Existence lets
 * callers drop "shadow" members — rows that point at a non-existent user, which
 * would otherwise render as a raw UUID in member lists.
 */
/**
 * One identity lookup = one HTTPS round trip to the Supabase auth admin API
 * (`auth.admin.getUserById`), and there is no batch form of it.
 *
 * That made this a network N+1 on the session-list hot path: `GET
 * /:projectId/sessions` resolves every distinct `created_by` in the project, so
 * a project with a human owner plus a few trigger/service actors paid one auth
 * round trip PER OWNER, on every one of the ~6 list fetches a single session
 * open issues (measured on the SampleCo corpus, 2026-08-26). The rest of the
 * endpoint is four indexed queries totalling under 3 ms; these calls were the
 * only unbounded work in it.
 *
 * A user's email and display name are effectively static, so the lookup is
 * memoized per uid. Two results are deliberately NOT cached:
 *
 *   - `exists: false` — a just-created user (invite accepted, SSO JIT) must
 *     resolve on the next request, not one TTL later.
 *   - the transient-failure fallback — caching it would pin a network hiccup
 *     for a whole TTL window across every caller.
 */
const USER_IDENTITY_TTL_MS = 60_000;

/**
 * Which identity answers are safe to keep for a TTL window.
 *
 * Exported because it is the whole correctness argument for caching an auth
 * lookup, and `ttlMemo` is bypassed under `bun test` — testing it through the
 * memo would assert nothing.
 */
export function userIdentityIsCacheable(
  value: UserIdentity & { transient?: boolean },
): boolean {
  return value.exists && !value.transient;
}

const userIdentityMemo = ttlMemo({
  ttlMs: USER_IDENTITY_TTL_MS,
  keyFn: (uid: string) => uid,
  // Only a POSITIVE, non-degraded answer is worth keeping. `transient` marks
  // the catch-branch fallback so it is distinguishable from a real lookup that
  // legitimately returned no email.
  shouldCache: userIdentityIsCacheable,
  loader: async (uid: string): Promise<UserIdentity & { transient?: boolean }> => {
    try {
      const { data } = await getSupabase().auth.admin.getUserById(uid);
      // A completed call with no user object = the id is not a real user.
      const user = data?.user ?? null;
      const metadata = user?.user_metadata as Record<string, unknown> | undefined;
      const displayName =
        typeof metadata?.name === 'string'
          ? metadata.name
          : typeof metadata?.full_name === 'string'
            ? metadata.full_name
            : null;
      return { email: user?.email ?? null, displayName, exists: !!user };
    } catch {
      // Transient (network/5xx) — assume the user exists; don't hide them.
      return { email: null, displayName: null, exists: true, transient: true };
    }
  },
});

interface AuthUserRow {
  id: string;
  email: string | null;
  name: string | null;
  full_name: string | null;
}

/**
 * One query for every identity, from the auth table the API's own database
 * connection already reads (`scim/app.ts`, `admin/index.ts`).
 *
 * Why (2026-09-27): prod `GET /:projectId/sessions` still made 4–6 auth admin
 * calls (`gotrue;dur=70–140`) on EVERY list fetch. The memo above keeps only
 * positive answers, and a project's `created_by` includes principals that are
 * not auth users (triggers, agents, service accounts), so those ids missed
 * the memo every time. The table answers "no such user" definitively, in the
 * same round trip as the rest.
 */
async function readAuthUsers(ids: string[]): Promise<AuthUserRow[]> {
  return (await db.execute(sql`
    SELECT u.id::text AS id,
           u.email,
           u.raw_user_meta_data->>'name' AS name,
           u.raw_user_meta_data->>'full_name' AS full_name
    FROM auth.users u
    WHERE u.id = ANY(${`{${ids.join(',')}}`}::uuid[])
  `)) as unknown as AuthUserRow[];
}

export async function resolveUserIdentities(
  userIds: string[],
  deps: {
    readAuthUsers?: (ids: string[]) => Promise<AuthUserRow[]>;
    lookupUser?: (uid: string) => Promise<UserIdentity & { transient?: boolean }>;
  } = {},
): Promise<Map<string, UserIdentity>> {
  const result = new Map<string, UserIdentity>();
  if (userIds.length === 0) return result;
  const unique = [...new Set(userIds)];
  // A non-UUID id cannot be an auth user; it never reaches the ::uuid[] cast.
  const candidates = unique.filter(isUuid);
  let rows: AuthUserRow[] | null = null;
  try {
    rows = candidates.length ? await (deps.readAuthUsers ?? readAuthUsers)(candidates) : [];
  } catch {
    rows = null;
  }
  if (rows) {
    const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
    for (const uid of unique) {
      const row = byId.get(uid.toLowerCase());
      result.set(uid, {
        email: row?.email ?? null,
        displayName: row?.name ?? row?.full_name ?? null,
        exists: !!row,
      });
    }
    return result;
  }
  // The table is unreadable (a self-host without the auth schema grant):
  // the auth admin API, one memoized call per user, as before.
  await Promise.all(
    unique.map(async (uid) => {
      const { transient: _transient, ...identity } = await (deps.lookupUser ?? userIdentityMemo)(uid);
      result.set(uid, identity);
    }),
  );
  return result;
}

export async function resolveSessionOwnerIdentities(
  ownerIds: string[],
  accountId: string,
): Promise<Map<string, SessionOwnerIdentity>> {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (uniqueOwnerIds.length === 0) return new Map();

  const users = await resolveUserIdentities(uniqueOwnerIds);
  const unresolvedIds = uniqueOwnerIds.filter((ownerId) => !users.get(ownerId)?.exists);
  const machineIdentities = unresolvedIds.length
    ? await db
        .select({
          serviceAccountId: serviceAccounts.serviceAccountId,
          name: serviceAccounts.name,
          agentName: serviceAccounts.agentName,
        })
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.accountId, accountId),
            inArray(serviceAccounts.serviceAccountId, unresolvedIds),
          ),
        )
    : [];

  return mergeSessionOwnerIdentities({
    ownerIds: uniqueOwnerIds,
    users,
    serviceAccounts: machineIdentities,
  });
}

export async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const identities = await resolveUserIdentities(userIds);
  const result = new Map<string, string | null>();
  for (const [uid, identity] of identities) result.set(uid, identity.email);
  return result;
}


// Moved verbatim from ./git (KRTX-301): the authorization path must not import
// the Git module. Same memo, same impersonation rules.
// Memoized briefly (positive hits only): this runs on every project-scoped
// request. Each DB statement is a fast same-region roundtrip (~3ms measured,
// not the cross-region cost this comment used to claim), but the same
// lookup repeats across a burst of parallel requests, so caching still cuts
// redundant query volume. A revoked membership lingers for at most one TTL
// window; a fresh grant is visible immediately because null results are
// never cached.
const loadAccountMembership = ttlMemo({
  ttlMs: 15_000,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: async (userId: string, accountId: string) => {
    // Membership IS the account-scope assignment (spec §1). The
    // `account_members.account_role` column this used to read is no longer
    // written by every path — an assignment made through `assignRole()` leaves
    // it stale on purpose — so reading it here would hand a project request a
    // role the engine disagrees with.
    const accountRole = await accountRoleFor(accountId, userId);
    return accountRole ? { accountId, accountRole } : null;
  },
  shouldCache: (membership) => membership !== null,
});
// Key is `${userId}|${accountId}` → bust per principal on account-member changes.
registerPrincipalScopedMemo(loadAccountMembership);

export async function getAccountMembership(userId: string, accountId: string) {
  // Act-as: a platform admin holding a live grant on this account resolves as
  // its owner. Checked BEFORE the memo, never inside it — `loadAccountMembership`
  // is keyed `${userId}|${accountId}` and shared across requests, so caching an
  // impersonation-derived membership would hand the operator owner rights on
  // their own later, non-impersonated requests for the whole TTL window.
  if (isImpersonatingAccount(userId, accountId)) {
    return { accountId, accountRole: 'owner' as const };
  }
  // …and CONFINES: while a grant is live, the operator's own memberships are
  // out of reach. Otherwise "open the app" lands on their last project (a
  // cookie), which is theirs, under a banner naming the customer.
  if (isImpersonationBlockedAccount(userId, accountId)) return null;
  return loadAccountMembership(userId, accountId);
}
