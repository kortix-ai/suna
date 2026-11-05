import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../types';
import {
  requestAccountDeletion,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  deleteAccountImmediately,
  deleteLoginWithoutAccount,
} from '../services/account-deletion';
import { isNoWorkspaceError, noWorkspaceError } from '../../shared/no-workspace';
import { resolveAccountId } from '../../shared/resolve-account';
import { makeOpenApiApp, json, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';

import { actorOf } from '../../iam/actor';
import { readJsonObject } from '../../shared/http-body';
export const accountDeletionRouter = makeOpenApiApp<AppEnv>();

async function resolveDeletionContext(c: any) {
  const userId = c.get('userId') as string;
  const accountId = await resolveAccountId(userId);
  await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_DELETE);
  return { userId, accountId };
}

/**
 * The deletion context, or `null` for a person who belongs to no workspace
 * (no account is created at sign-up). Such a person still deletes their
 * login: the routes below answer for that case instead of a 409.
 */
async function deletionContextOrNone(c: Context<AppEnv>): Promise<{ userId: string; accountId: string } | null> {
  try {
    return await resolveDeletionContext(c);
  } catch (err) {
    if (isNoWorkspaceError(err) && c.get('authType') === 'supabase') return null;
    throw err;
  }
}

const NO_PENDING_DELETION = {
  has_pending_deletion: false,
  deletion_scheduled_for: null,
  requested_at: null,
  can_cancel: false,
};

// Opaque service results (status / success payloads) — permissive on purpose.
const ResultSchema = z.record(z.string(), z.any());

accountDeletionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/deletion-status',
    tags: ['billing'],
    summary: 'Get the current account-deletion status',
    ...auth,
    responses: {
      200: json(ResultSchema, 'Account deletion status'),
    },
  }),
  async (c: any) => {
    const context = await deletionContextOrNone(c);
    if (!context) return c.json(NO_PENDING_DELETION);
    const result = await getAccountDeletionStatus(context.accountId);
    return c.json(result);
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'post',
    path: '/request-deletion',
    tags: ['billing'],
    summary: 'Request scheduled account deletion',
    ...auth,
    request: {
      body: {
        required: false,
        content: { 'application/json': { schema: z.object({ reason: z.string().optional() }) } },
      },
    },
    responses: {
      200: json(ResultSchema, 'Deletion request result'),
    },
  }),
  async (c: any) => {
    const context = await deletionContextOrNone(c);
    // A login with no workspace has nothing to keep for a grace period: the
    // client deletes it immediately instead (DELETE /delete-immediately).
    if (!context) {
      throw noWorkspaceError('You belong to no workspace, so nothing waits for a grace period. Delete your account immediately instead.');
    }
    const { accountId, userId } = context;
    // Manual parse: the body is optional and tolerant of missing/invalid JSON
    // (defaults to {}); only `reason` is read. valid('json') would reject a
    // bodyless request, changing the contract.
    const body = await readJsonObject(c);
    const result = await requestAccountDeletion(
      accountId,
      userId,
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    return c.json(result);
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'post',
    path: '/cancel-deletion',
    tags: ['billing'],
    summary: 'Cancel a pending account deletion',
    ...auth,
    responses: {
      200: json(ResultSchema, 'Cancellation result'),
    },
  }),
  async (c: any) => {
    const { accountId } = await resolveDeletionContext(c);
    const result = await cancelAccountDeletion(accountId);
    return c.json(result);
  },
);

accountDeletionRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/delete-immediately',
    tags: ['billing'],
    summary: 'Delete the account immediately',
    ...auth,
    responses: {
      200: json(ResultSchema, 'Immediate deletion result'),
    },
  }),
  async (c: any) => {
    const context = await deletionContextOrNone(c);
    // A person with no workspace deletes only their login.
    if (!context) return c.json(await deleteLoginWithoutAccount(c.get('userId') as string));
    const { accountId, userId } = context;
    // Pass `userId`: `resolveAccountId` above returns only the earliest-joined
    // account, so without it every sandbox in a team account this user owns
    // survives the deletion, still running and still billing.
    const result = await deleteAccountImmediately(accountId, userId);
    return c.json(result);
  },
);
