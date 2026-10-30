import { expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

// KRTX-2989: /credit-breakdown and /usage-history read c.get('userId') as the
// account, so a team account showed the caller's personal balance. They resolve
// the account like every sibling billing read: account_id, then billing.read.
const reads: string[] = [];
let billingReadDenied = false;
mock.module('../http-require-billing-write', () => ({
  resolveBillingWriteAccountId: async () => 'acct_team',
  resolveBillingReadAccountId: async () => {
    if (billingReadDenied) throw new HTTPException(403, { message: "You don't have permission to view billing." });
    return 'acct_team';
  },
}));
mock.module('../repositories/credit-accounts', () => ({
  getCreditBalance: async (accountId: string) => {
    reads.push(accountId);
    return { balance: '7', expiringCredits: '2', nonExpiringCredits: '5', dailyCreditsBalance: '0' };
  },
}));
mock.module('../repositories/transactions', () => ({
  getTransactionsSummary: async (accountId: string) => {
    reads.push(accountId);
    return {};
  },
}));
const { creditsRouter } = await import('./credits');

test.each(['/credit-breakdown', '/usage-history'])('GET %s reads the resolved account, not the caller', async (path) => {
  reads.length = 0;
  billingReadDenied = false;
  const response = await creditsRouter.fetch(new Request(`http://local${path}?account_id=acct_team`));
  expect(response.status).toBe(200);
  expect(reads).toEqual(['acct_team']);
});

test.each(['/credit-breakdown', '/usage-history'])('GET %s answers 403 without billing.read', async (path) => {
  reads.length = 0;
  billingReadDenied = true;
  const response = await creditsRouter.request(path);
  expect(response.status).toBe(403);
  expect(reads).toEqual([]);
});
