import { accountMembers } from "@kortix/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "./db";
import {
  IMPERSONATION_INVALID_CODE,
  impersonatedAccountFor,
} from "./impersonation";
import { isUuid } from "./validate";
import { noWorkspaceError } from "./no-workspace";
import { accountsView, projectsView } from "../workspaces/rows";

/**
 * The account a billing request targets, from plain values: the caller's user
 * id and the `account_id` the request named (query or body), if any. The HTTP
 * reader is `resolveScopedAccountId` in `middleware/resolve-account.ts`.
 *
 *   1. A named account → verify the caller is a member of it, then return it.
 *      403 on miss.
 *   2. Otherwise the account the credential is bound to (`boundAccountId`:
 *      a PAT's, an API key's, a service account's), when there is one.
 *   3. Otherwise the user's primary MEMBERSHIP. Never the bare-id fallback
 *      `resolveAccountId` keeps for API keys: a person whose id happens to
 *      name an account they no longer belong to (a legacy personal account
 *      they left) must not read or bill it. 409 `no_workspace` when the user
 *      belongs to no account.
 */
/**
 * A membership that still serves the account: every member of a live
 * workspace, and only the owners of a closing one (its deletion request is
 * open, K2). A former admin or member reads nothing of it, billing included.
 */
function servedMember() {
  return sql`(${accountMembers.accountRole} = 'owner' OR NOT EXISTS (
    SELECT 1 FROM kortix.account_deletion_requests r
     WHERE r.account_id = ${accountMembers.accountId} AND r.status IN ('pending', 'processing')))`;
}

export async function scopedAccountIdFor(
  userId: string,
  requested: string | undefined,
  boundAccountId?: string,
): Promise<string> {
  // Acting as an account: the target IS the scope. An explicit `account_id`
  // that disagrees is refused rather than honoured — a console still holding a
  // stale account id must not be able to steer a write out of the account the
  // banner says the operator is inside.
  const impersonated = impersonatedAccountFor(userId);
  if (impersonated) {
    if (
      requested &&
      requested !== impersonated &&
      (await accountKeyForWorkspaceId(requested)) !== impersonated
    ) {
      throw new HTTPException(403, {
        message: "Impersonated requests cannot target another workspace",
        res: new Response(
          JSON.stringify({
            error: "Impersonated requests cannot target another workspace",
            code: IMPERSONATION_INVALID_CODE,
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      });
    }
    return impersonated;
  }

  if (!requested) {
    if (boundAccountId) return boundAccountId;
    return resolveAccountId(userId, { allowAccountCredential: false });
  }

  // A malformed account id must not reach the uuid-typed account_members
  // column: Postgres answers 22P02 and the request dies as an opaque 500
  // (Better Stack pattern 97669531, KRTX-211). Answer exactly like a
  // membership miss — 403, no DB read, no hint whether the id exists.
  if (!isUuid(requested)) {
    throw new HTTPException(403, {
      message: "Not a member of the requested workspace",
    });
  }

  const [member] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.userId, userId),
        eq(accountMembers.accountId, requested),
        servedMember(),
      ),
    )
    .limit(1);

  if (member) return requested;

  // `account_id` also accepts the workspace id (`project_id`): map it to the
  // workspace's account key and check membership there. Only on a miss, so an
  // account key costs no extra query.
  const accountKey = await accountKeyForWorkspaceId(requested);
  if (accountKey) {
    const [viaWorkspace] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountKey), servedMember()))
      .limit(1);
    if (viaWorkspace) return accountKey;
  }

  throw new HTTPException(403, {
    message: "Not a member of the requested workspace",
  });
}

/**
 * The workspace id of each account key: its one active project. An account
 * with 0 active projects (dormant) or several (`split_pending`, not split yet)
 * maps to null. One query for the whole list.
 */
export async function workspaceIdsForAccounts(accountIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(accountIds.filter(isUuid))];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ accountId: projectsView.accountId, projectId: projectsView.projectId })
    .from(projectsView)
    .where(and(inArray(projectsView.accountId, ids), eq(projectsView.status, "active")));
  for (const id of ids) out.set(id, null);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
  for (const row of rows) if (counts.get(row.accountId) === 1) out.set(row.accountId, row.projectId);
  return out;
}

/**
 * The account key of an active workspace, by its workspace id (`project_id`).
 * Null for any other id (an account key, an archived project, garbage).
 * Request fields named `account_id` accept either workspace key through this.
 */
export async function accountKeyForWorkspaceId(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({ accountId: projectsView.accountId })
    .from(projectsView)
    .where(and(eq(projectsView.projectId, id), eq(projectsView.status, "active")))
    .limit(1);
  return row?.accountId ?? null;
}

async function accountExists(accountId: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const [row] = await db
    .select({ accountId: accountsView.accountId })
    .from(accountsView)
    .where(eq(accountsView.accountId, accountId))
    .limit(1);
  return Boolean(row);
}

/**
 * The caller's default account: their earliest-joined membership.
 *
 * Throws `noWorkspaceError()` (409 `no_workspace`) when the caller belongs to
 * no account. Nothing is created here: account creation is always explicit.
 *
 * One exception keeps machine credentials working: a sandbox / account API
 * key authenticates with `userId = accountId` (middleware/auth.ts,
 * `resolveSandboxToken`). That id has no `account_members` row, so when the
 * id IS an existing account it is returned as-is — the same answer the
 * removed bootstrap gave such callers (its insert was a conflict no-op).
 */
export async function resolveAccountId(
  userId: string,
  options: { allowAccountCredential?: boolean } = {},
): Promise<string> {
  // Impersonation is resolved BEFORE the membership lookup, not after: the
  // operator has no `account_members` row in the target account, so falling
  // through would return their OWN account and quietly mis-scope every write
  // the console believes it is making on the customer's behalf.
  const impersonated = impersonatedAccountFor(userId);
  if (impersonated) return impersonated;

  // NOTE: a failing membership lookup must THROW, not fall through — silently
  // treating a DB error as "no membership" would mis-scope a multi-account
  // user.
  const [membership] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(eq(accountMembers.userId, userId))
    // Deterministic "primary account" = the user's earliest-joined account
    // (their original). No personal/team flag — there is no such thing now;
    // a bare (account-agnostic) lookup must be stable, not pick-whatever-row.
    .orderBy(accountMembers.joinedAt)
    .limit(1);

  // No billing side effect here: the legacy Stripe recovery runs only from
  // `POST /v1/billing/sync-subscription` (design.md §3.1 finding 8).
  if (membership) return membership.accountId;

  // A sandbox / account API key: `userId` is the account id itself.
  if (options.allowAccountCredential !== false && (await accountExists(userId))) return userId;

  throw noWorkspaceError();
}
