import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import {
  requestAccountDeletion,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  deleteAccountImmediately,
} from '../services/account-deletion';
import { resolveAccountId } from '../../shared/resolve-account';
import { makeOpenApiApp, json, auth } from '../../openapi';

export const accountDeletionRouter = makeOpenApiApp<AppEnv>();

async function resolveDeletionContext(c: any) {
  const userId = c.get('userId') as string;
  const accountId = await resolveAccountId(userId);
  return { userId, accountId };
}

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
    const { accountId } = await resolveDeletionContext(c);
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
        content: { 'application/json': { schema: z.object({ reason: z.string().optional() }) } },
      },
    },
    responses: {
      200: json(ResultSchema, 'Deletion request result'),
    },
  }),
  async (c: any) => {
    const { accountId, userId } = await resolveDeletionContext(c);
    // Manual parse: the body is optional and tolerant of missing/invalid JSON
    // (defaults to {}); only `reason` is read. valid('json') would reject a
    // bodyless request, changing the contract.
    const body = await c.req.json().catch(() => ({}));
    const result = await requestAccountDeletion(accountId, userId, body.reason);
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
    const { accountId } = await resolveDeletionContext(c);
    const result = await deleteAccountImmediately(accountId);
    return c.json(result);
  },
);
