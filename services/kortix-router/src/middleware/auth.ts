import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';

const TEST_TOKEN = '00000';
const TEST_ACCOUNT = 'test_account';

/**
 * Validates the KORTIX_TOKEN from Authorization header.
 *
 * Auth Flow (mirrors Python implementation):
 * - Token "00000" = test_account (skip billing)
 * - Other tokens = treat as account_id (temporary, until DB lookup is implemented)
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice(7);

  if (!token) {
    throw new HTTPException(401, {
      message: 'Missing token in Authorization header',
    });
  }

  // For testing: "00000" token = skip billing
  if (token === TEST_TOKEN) {
    c.set('accountId', TEST_ACCOUNT);
    await next();
    return;
  }

  // TODO: Real token validation - lookup token in DB to get account_id
  // For now, treat token as account_id directly (temporary)
  c.set('accountId', token);

  await next();
}

/**
 * Check if the current request is from a test account.
 */
export function isTestAccount(accountId: string): boolean {
  return accountId === TEST_ACCOUNT;
}
