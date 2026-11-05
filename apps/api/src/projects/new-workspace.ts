/**
 * `new_workspace: true` on `POST /v1/projects/provision` (and
 * `/provision-stream`): create a whole workspace in one request.
 *
 * A workspace is one account and its one project (Workspaces D2: the
 * workspace id is the `project_id`). The caller names no account. The server
 * picks it:
 *
 *   1. the account a retry of the same `idempotency_key` already provisioned
 *      into, so the replay finds its project (the key is scoped to the
 *      account, and the account is chosen here);
 *   2. else the caller's NEWEST OWNED account with 0 active projects and no
 *      pending deletion, so an empty account the person already holds (an old
 *      sign-up's personal account, with whatever plan or credits it has) is
 *      reused instead of stranded;
 *   3. else a new account (`createOwnedAccount`: owner membership + owner
 *      role, free tier, Mailtrap), named after the project, unless
 *      `KORTIX_RESTRICT_ACCOUNT_CREATION` forbids it for this caller (403
 *      `account_creation_restricted`, the same answer as POST /v1/accounts).
 *
 * The choice runs under a per-person advisory lock when a key is present, so
 * two concurrent attempts of one create pick the same account; the partial
 * unique index on `(account_id, idempotency_key)` then lets exactly one of
 * them provision (provision-core.ts, the loser rollback).
 */
import { accountDeletionRequests, accounts, projects } from '@kortix/db';
import { and, desc, eq, inArray, notExists, sql } from 'drizzle-orm';

import { createOwnedAccount } from '../accounts/core/create-account';
import { config } from '../config';
import { accountRolesForUser } from '../iam/read-models';
import { db } from '../shared/db';
import { impersonatedAccountFor } from '../shared/impersonation';
import { isPlatformAdmin } from '../shared/platform-roles';
import type { ProvisionResult } from './provision-core';

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

/**
 * The owned account to reuse: the one holding `idempotencyKey` first, else the
 * newest with 0 active projects. `null` when there is none.
 */
async function reusableOwnedAccount(userId: string, idempotencyKey: string | null): Promise<string | null> {
  const roles = await accountRolesForUser(userId);
  const owned = [...roles].filter(([, role]) => role === 'owner').map(([accountId]) => accountId);
  if (owned.length === 0) return null;

  if (idempotencyKey) {
    const [keyed] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(and(inArray(projects.accountId, owned), eq(projects.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (keyed) return keyed.accountId;
  }

  const [empty] = await db
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(
      and(
        inArray(accounts.accountId, owned),
        notExists(
          db
            .select({ one: sql`1` })
            .from(projects)
            .where(and(eq(projects.accountId, accounts.accountId), eq(projects.status, 'active'))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(accountDeletionRequests)
            .where(
              and(
                eq(accountDeletionRequests.accountId, accounts.accountId),
                inArray(accountDeletionRequests.status, ['pending', 'processing']),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(accounts.createdAt))
    .limit(1);
  return empty?.accountId ?? null;
}

async function chooseOrCreate(
  caller: NewWorkspaceCaller,
  name: string,
  idempotencyKey: string | null,
): Promise<NewWorkspaceAccount> {
  const reused = await reusableOwnedAccount(caller.userId, idempotencyKey);
  if (reused) return { ok: true, accountId: reused, created: false };

  if (config.KORTIX_RESTRICT_ACCOUNT_CREATION && !(await isPlatformAdmin(caller.userId))) {
    return refuse(
      403,
      'Creating new workspaces is restricted to the server admin on this deployment. Ask an admin to invite you.',
      'account_creation_restricted',
    );
  }
  const account = await createOwnedAccount({ userId: caller.userId, name, email: caller.email });
  return { ok: true, accountId: account.accountId, created: true };
}

/**
 * Pick or create the account a new workspace provisions into. `name` is the
 * already-validated project name; `idempotencyKey` the parsed key or null.
 */
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
