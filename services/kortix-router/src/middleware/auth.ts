import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSecretKey } from '../repositories/api-keys';
import { isSupabaseConfigured } from '../lib/supabase';

const TEST_TOKEN = '00000';
const TEST_ACCOUNT = 'test_account';

/**
 * Validates API key from Authorization header.
 *
 * Auth Flow:
 * - Token "00000" = test_account (skip billing)
 * - Token "sk_xxx" = validate against api_keys table, get account_id
 * - Other tokens = treat as account_id directly (backward compat / fallback)
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

  // Test token bypass
  if (token === TEST_TOKEN) {
    c.set('accountId', TEST_ACCOUNT);
    c.set('isTestAccount', true);
    await next();
    return;
  }

  // API key validation (sk_xxx format)
  if (token.startsWith('sk_') && isSupabaseConfigured()) {
    const result = await validateSecretKey(token);

    if (!result.isValid) {
      throw new HTTPException(401, {
        message: result.error || 'Invalid API key',
      });
    }

    c.set('accountId', result.accountId);
    c.set('keyId', result.keyId);
    c.set('isTestAccount', false);
    await next();
    return;
  }

  // Fallback: treat token as account_id directly (backward compat)
  c.set('accountId', token);
  c.set('isTestAccount', false);
  await next();
}

/**
 * Check if the current request is from a test account.
 */
export function isTestAccount(accountId: string): boolean {
  return accountId === TEST_ACCOUNT;
}
