import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { resolveRequestedProjectAccount } from './project-access';

// A service account has no account_members row (KRTX-4432). The account gate
// puts it in the account its credential belongs to, never another one. These
// cases decide before any database read; the cross-account 403 and the
// granted-project list are pinned end to end by flow IAM-45.

const SERVICE_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OWN_ACCOUNT = '22222222-2222-4222-8222-222222222222';

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

describe('resolveRequestedProjectAccount for a service account', () => {
  test('no account_id: acts in its own account with the member label', async () => {
    expect(await resolveRequestedProjectAccount(SERVICE_ACCOUNT, null, OWN_ACCOUNT)).toEqual({
      userId: SERVICE_ACCOUNT,
      accountId: OWN_ACCOUNT,
      accountRole: 'member',
    });
  });

  test('account_id naming its own account: the same scope', async () => {
    const scope = await resolveRequestedProjectAccount(SERVICE_ACCOUNT, OWN_ACCOUNT, OWN_ACCOUNT);
    expect(scope.accountId).toBe(OWN_ACCOUNT);
  });

  test('a credential without an account → 403', async () => {
    expect(await statusOf(resolveRequestedProjectAccount(SERVICE_ACCOUNT, null, ''))).toBe(403);
  });

  test('a malformed account_id → 400 before any lookup', async () => {
    expect(await statusOf(resolveRequestedProjectAccount(SERVICE_ACCOUNT, 'not-a-uuid', OWN_ACCOUNT))).toBe(400);
  });
});
