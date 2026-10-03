import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import {
  requestAccountDeletion,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  deleteAccountImmediately,
} from '../services/account-deletion';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { makeOpenApiApp, json, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';

import { actorOf } from '../../iam/actor';
import { readJsonObject } from '../../shared/http-body';
export const accountDeletionRouter = makeOpenApiApp<AppEnv>();

// Every route resolves its account through the shared scope resolver: an
// explicit `account_id` (the account hub's danger zone targets the account it
// is open on) is authorized as a MEMBERSHIP of the caller plus
// `account.delete` on that account; no param keeps the legacy default — the
// caller's primary account.
async function resolveDeletionContext(c: any, source: 'query' | 'body') {
  const userId = c.get('userId') as string;
  const accountId = await resolveScopedAccountId(c, source);
  await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_DELETE);
  return { userId, accountId };
}

const AccountIdQuerySchema = z.object({ account_id: z.string().optional() });

// Opaque service results (status / success payloads) — permissive on purpose.
const ResultSchema = z.record(z.string(), z.any());

accountDeletionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/deletion-status',
    tags: ['billing'],
    summary: 'Get the current account-deletion status',
    ...auth,
    request: { query: AccountIdQuerySchema },
    responses: {
      200: json(ResultSchema, 'Account deletion status'),
    },
  }),
  async (c: any) => {
    const { accountId } = await resolveDeletionContext(c, 'query');
    const result = await getAccountDeletionStatus(accountId);
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
        content: {
          'application/json': {
            schema: z.object({ reason: z.string().optional(), account_id: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: json(ResultSchema, 'Deletion request result'),
    },
  }),
  async (c: any) => {
    const { accountId, userId } = await resolveDeletionContext(c, 'body');
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
    // No declared body: the legacy mobile client POSTs here with a
    // `Content-Type: application/json` header and an EMPTY body, which a
    // declared JSON body schema would reject. The scope is read tolerantly
    // by `resolveScopedAccountId` (no body = the caller's primary account).
    responses: {
      200: json(ResultSchema, 'Cancellation result'),
    },
  }),
  async (c: any) => {
    const { accountId } = await resolveDeletionContext(c, 'body');
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
    request: { query: AccountIdQuerySchema },
    responses: {
      200: json(ResultSchema, 'Immediate deletion result'),
    },
  }),
  async (c: any) => {
    const { accountId, userId } = await resolveDeletionContext(c, 'query');
    // Pass `userId`: the service deletes the auth identity and widens the
    // sandbox sweep to every account the user OWNS only when the target IS
    // their primary account; a scoped team-account deletion tears down that
    // account alone and keeps the caller signed in.
    const result = await deleteAccountImmediately(accountId, userId);
    return c.json(result);
  },
);
