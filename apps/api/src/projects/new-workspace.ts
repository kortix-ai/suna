/**
 * `new_workspace: true` on `POST /v1/projects/provision` (and
 * `/provision-stream`): create a whole workspace in one request.
 *
 * A workspace is one account and its one project (Workspaces D2: the
 * workspace id is the `project_id`). The caller names no account. The server
 * picks it (design.md §3.1 items 1 and 9: no reuse):
 *
 *   1. with an `idempotency_key`, the account a replay of the same create
 *      already holds: the one its project carries the key in, or the virgin
 *      account a concurrent attempt just created (`replayedAccount`);
 *   2. else ALWAYS a new account (`createOwnedAccount`: owner membership +
 *      owner role, free tier, Mailtrap), named after the project, unless
 *      `KORTIX_RESTRICT_ACCOUNT_CREATION` forbids it for this caller (403
 *      `account_creation_restricted`, the same answer as POST /v1/accounts).
 *
 * No other account is ever reused. An owned account with no active project
 * is either a deleted workspace (closing: its members, grants, secrets and
 * subscription must never reach a new workspace, review finding 1) or a
 * dormant one (its own workspace, listed as `setup_required` when it pays,
 * set up through `POST /v1/workspaces/:id/setup`).
 *
 * The choice runs under a per-person advisory lock when a key is present, so
 * two concurrent attempts of one create pick the same account; the partial
 * unique index on `(account_id, idempotency_key)` then lets exactly one of
 * them provision (provision-core.ts, the loser rollback).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { createOwnedAccount } from '../accounts/core/create-account';
import { config } from '../config';
import { accountRolesForUser } from '../iam/read-models';
import { db } from '../shared/db';
import { impersonatedAccountFor } from '../shared/impersonation';
import { isPlatformAdmin } from '../shared/platform-roles';
import type { ProvisionResult } from './provision-core';
import { projectsView } from '../workspaces/rows';

/** Who is asking: only a person creates a workspace. */
export interface NewWorkspaceCaller {
  userId: string;
  email: string | null;
  authType: string | undefined;
  /** A project-scoped, session-bound or agent token: not a person acting freely. */
  scopedCredential: boolean;
}

export type NewWorkspaceAccount =
  | { ok: true; accountId: string; created: boolean }
  | { ok: false; result: ProvisionResult };

const refuse = (status: 400 | 403, error: string, code: string): NewWorkspaceAccount => ({
  ok: false,
  result: { status, body: { error, code } },
});

/** The 400 when a body names both a target account and `new_workspace`. */
export const NEW_WORKSPACE_WITH_ACCOUNT_CODE = 'new_workspace_with_account_id';

/** Does this provision body ask for a new workspace? Only a literal `true` counts. */
export function wantsNewWorkspace(body: Record<string, unknown>): boolean {
  return body.new_workspace === true || body.newWorkspace === true;
}

/** `new_workspace` and `account_id` exclude each other: one names the target, the other says there is none yet. */
export function newWorkspaceConflict(body: Record<string, unknown>): ProvisionResult | null {
  const named = [body.account_id, body.accountId].some((v) => typeof v === 'string' && v.trim() !== '');
  if (!named) return null;
  return {
    status: 400,
    body: {
      error: 'Send either new_workspace or account_id, not both',
      code: NEW_WORKSPACE_WITH_ACCOUNT_CODE,
    },
  };
}

/** How long an in-flight create's account counts as that create's (see `replayedAccount`). */
export const IN_FLIGHT_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/**
 * A virgin account: `userId` owns it and is its only member, it holds no
 * project row of any status, no invitation, no deletion request and no grant
 * for anyone else, and it was created after `since`. The one predicate for
 * "an account nobody has used yet". A deleted workspace (a project row and a
 * deletion request) and a shared account never match.
 */
async function virginAccountOf(userId: string, owned: string[], since: Date): Promise<string | null> {
  if (owned.length === 0) return null;
  const [row] = await db.execute<{ account_id: string }>(sql`
    SELECT a.account_id::text AS account_id
      FROM kortix.accounts a
     WHERE a.account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(owned)}::jsonb))
       AND a.created_at > ${since.toISOString()}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM kortix.projects p WHERE p.account_id = a.account_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.account_memberships m
                        WHERE m.account_id = a.account_id AND m.user_id <> ${userId}::uuid)
       AND NOT EXISTS (SELECT 1 FROM kortix.account_invitations i WHERE i.account_id = a.account_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.account_deletion_requests r WHERE r.account_id = a.account_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.role_assignments ra
                        WHERE ra.account_id = a.account_id
                          AND NOT (ra.principal_type = 'user' AND ra.principal_id = ${userId}::uuid))
     ORDER BY a.created_at DESC
     LIMIT 1`);
  return row?.account_id ?? null;
}

/**
 * The account an idempotent replay of the same create returns, or `null`.
 * The only account a create ever returns that it did not just make:
 *   1. the owned account whose project carries `idempotencyKey` (a retry after
 *      a lost response);
 *   2. else a virgin account the caller created in the last
 *      `IN_FLIGHT_ACCOUNT_WINDOW_MS` (a concurrent attempt of the same create
 *      that has its account but not its project yet). Under the per-person
 *      advisory lock, so two attempts converge on one account; the unique
 *      index on (account_id, idempotency_key) lets one of them provision.
 * Without a key there is no "same create": always a new account.
 */
async function replayedAccount(userId: string, idempotencyKey: string | null): Promise<string | null> {
  if (!idempotencyKey) return null;
  const roles = await accountRolesForUser(userId);
  const owned = [...roles].filter(([, role]) => role === 'owner').map(([accountId]) => accountId);
  if (owned.length === 0) return null;
  const [keyed] = await db
    .select({ accountId: projectsView.accountId })
    .from(projectsView)
    .where(and(inArray(projectsView.accountId, owned), eq(projectsView.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (keyed) return keyed.accountId;
  return virginAccountOf(userId, owned, new Date(Date.now() - IN_FLIGHT_ACCOUNT_WINDOW_MS));
}

/**
 * `403 account_creation_restricted` when this deployment lets only a platform
 * admin create a new account (`KORTIX_RESTRICT_ACCOUNT_CREATION`), else null.
 * A route that writes upstream before it creates the account (create-repo)
 * asks first, so a refused create leaves no repository behind.
 */
export async function newWorkspaceRestriction(userId: string): Promise<ProvisionResult | null> {
  if (!config.KORTIX_RESTRICT_ACCOUNT_CREATION || (await isPlatformAdmin(userId))) return null;
  return {
    status: 403,
    body: {
      error: 'Creating new workspaces is restricted to the server admin on this deployment. Ask an admin to invite you.',
      code: 'account_creation_restricted',
    },
  };
}

async function chooseOrCreate(
  caller: NewWorkspaceCaller,
  name: string,
  idempotencyKey: string | null,
): Promise<NewWorkspaceAccount> {
  const reused = await replayedAccount(caller.userId, idempotencyKey);
  if (reused) return { ok: true, accountId: reused, created: false };

  const restricted = await newWorkspaceRestriction(caller.userId);
  if (restricted) return { ok: false, result: restricted };
  const account = await createOwnedAccount({ userId: caller.userId, name, email: caller.email });
  return { ok: true, accountId: account.accountId, created: true };
}

/**
 * Who may create a workspace: a person (a browser JWT or an unscoped PAT),
 * never an API key, a service account, a project/session/agent token or an
 * impersonating operator. `null` when the caller may. Runs before the request
 * checks: authorization is decided before input validation.
 */
export function newWorkspaceCallerDenial(caller: NewWorkspaceCaller): ProvisionResult | null {
  if (impersonatedAccountFor(caller.userId)) {
    return { status: 403, body: { error: 'Impersonated requests cannot create a workspace', code: 'impersonation_invalid' } };
  }
  const person = caller.authType === 'supabase' || caller.authType === 'pat';
  if (!person || caller.scopedCredential) {
    return {
      status: 403,
      body: {
        error: 'Only a person creates a workspace: sign in, or use an unscoped personal access token',
        code: 'new_workspace_requires_person',
      },
    };
  }
  return null;
}

/**
 * Pick or create the account a new workspace provisions into. `name` is the
 * already-validated project name; `idempotencyKey` the parsed key or null.
 */
export async function resolveNewWorkspaceAccount(
  caller: NewWorkspaceCaller,
  name: string,
  idempotencyKey: string | null,
): Promise<NewWorkspaceAccount> {
  const denial = newWorkspaceCallerDenial(caller);
  if (denial) return { ok: false, result: denial };

  // Without a key there is no "same create" to converge on: no lock, and two
  // submits make two workspaces (each its own account), never two projects
  // in one account.
  if (!idempotencyKey) return chooseOrCreate(caller, name, null);

  return db.transaction(async (tx) => {
    // Held until the transaction ends. The choice (and a creation) commits on
    // other pool connections inside it, so a concurrent attempt with the same
    // person waits here, then sees the account this one picked or made.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`kortix:new-workspace:${caller.userId}`}, 0))`);
    return chooseOrCreate(caller, name, idempotencyKey);
  });
}
