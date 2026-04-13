import { Hono } from 'hono';
import {
  requestAccountDeletion,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  deleteAccountImmediately,
} from '../services/account-deletion';
import { resolveAccountId } from '../../shared/resolve-account';

export const accountDeletionRouter = new Hono();

async function resolveDeletionContext(c: any) {
  const userId = c.get('userId') as string;
  const accountId = await resolveAccountId(userId);
  return { userId, accountId };
}

accountDeletionRouter.get('/deletion-status', async (c: any) => {
  const { accountId } = await resolveDeletionContext(c);
  const result = await getAccountDeletionStatus(accountId);
  return c.json(result);
});

accountDeletionRouter.post('/request-deletion', async (c: any) => {
  const { accountId, userId } = await resolveDeletionContext(c);
  const body = await c.req.json().catch(() => ({}));
  const result = await requestAccountDeletion(accountId, userId, body.reason);
  return c.json(result);
});

accountDeletionRouter.post('/cancel-deletion', async (c: any) => {
  const { accountId } = await resolveDeletionContext(c);
  const result = await cancelAccountDeletion(accountId);
  return c.json(result);
});

accountDeletionRouter.delete('/delete-immediately', async (c: any) => {
  const { accountId } = await resolveDeletionContext(c);
  const result = await deleteAccountImmediately(accountId);
  return c.json(result);
});
