import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * BILLING-CORRECTNESS: the Slack channel's model gate must ask the ONE
 * managed-models question, not re-derive it.
 *
 * `channelModelContext` used to compute `freeManagedOnly` itself, as
 * `accountIsFreeTierForModels(await getAccountTier(accountId))` — a pure
 * tier-string check. That silently ignored `credit_accounts.managed_models_
 * override`, the operator column that grants or withdraws managed models
 * independently of the plan. An account an operator had granted managed models
 * still got a Zen-only picker in Slack while every other surface showed it the
 * full lineup, and an account force-restricted to BYOK still got managed models
 * offered in Slack. The gate now calls `accountMayUseManagedModels`, which
 * applies the override (and the trial overlay) inside the shared resolver.
 *
 * The billing layer is deliberately NOT mocked here: the real resolver runs
 * against a stubbed credit_accounts row, so this covers the whole path from the
 * column to the flag the picker reads.
 */

let billingEnabled = true;
mock.module('../../../config', () => ({
  config: new Proxy(
    {},
    {
      get: (_t, key) => (key === 'KORTIX_BILLING_INTERNAL_ENABLED' ? billingEnabled : undefined),
    },
  ),
}));

// FIFO db mock: channelModelContext reads the project row (the owner comes from
// the read-model mock below).
let dbResults: Array<unknown[]> = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'limit', 'leftJoin', 'orderBy'])
    chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../../shared/db', () => ({
  db: { select: () => makeChain() },
  hasDatabase: () => true,
}));

mock.module('../selection', () => ({
  currentChannelSelection: async () => ({ projectId: 'p1' }),
}));

// The account OWNER now comes from `role_assignments` via iam/read-models, not
// from an `account_members.account_role` query — so it is mocked at that seam
// rather than as a second FIFO db result.
mock.module('../../../iam/read-models', () => ({
  accountRoleMap: async () => new Map([['user-1', 'owner']]),
}));

let creditRow: Record<string, unknown> | null = null;
mock.module('../../../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => creditRow,
}));

const { channelModelContext } = await import('../model-gate');
const { invalidateAccountBilling } = await import('../../../billing/services/billing-cache');

const ctx = {} as any;

async function gateFor(row: Record<string, unknown> | null) {
  creditRow = row;
  dbResults = [[{ accountId: 'acct-1' }]];
  const resolved = await channelModelContext(ctx);
  expect(resolved).not.toBeNull();
  return resolved as NonNullable<typeof resolved>;
}

describe('channelModelContext — freeManagedOnly honors managed_models_override', () => {
  beforeEach(() => {
    billingEnabled = true;
    invalidateAccountBilling();
  });

  test('free plan, no override → managed models withheld (unchanged)', async () => {
    expect((await gateFor({ tier: 'free' })).freeManagedOnly).toBe(true);
  });

  test('paid plan, no override → managed models offered (unchanged)', async () => {
    expect((await gateFor({ tier: 'per_seat' })).freeManagedOnly).toBe(false);
  });

  test('THE BUG: override=true on a free plan now grants managed models', async () => {
    // Old behavior: freeManagedOnly stayed true because the tier string was
    // still 'free'. The operator grant was invisible to Slack only.
    expect((await gateFor({ tier: 'free', managedModelsOverride: true })).freeManagedOnly).toBe(
      false,
    );
  });

  test('THE BUG, other direction: override=false on a paid plan withdraws them', async () => {
    expect(
      (await gateFor({ tier: 'per_seat', managedModelsOverride: false })).freeManagedOnly,
    ).toBe(true);
  });

  test('override=null defers to the plan', async () => {
    expect((await gateFor({ tier: 'free', managedModelsOverride: null })).freeManagedOnly).toBe(
      true,
    );
    invalidateAccountBilling();
    expect((await gateFor({ tier: 'pro', managedModelsOverride: null })).freeManagedOnly).toBe(
      false,
    );
  });

  test('an active trial of a paid plan grants managed models', async () => {
    const row = {
      tier: 'free',
      trialStatus: 'active',
      trialTier: 'tier_25_200',
      trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect((await gateFor(row)).freeManagedOnly).toBe(false);
  });

  test('no credit row at all → fail closed', async () => {
    expect((await gateFor(null)).freeManagedOnly).toBe(true);
  });

  test('billing disabled (self-host) → never gated, whatever the row says', async () => {
    billingEnabled = false;
    expect((await gateFor({ tier: 'free' })).freeManagedOnly).toBe(false);
  });

  test('the resolved context still carries the project + owner it looked up', async () => {
    const resolved = await gateFor({ tier: 'free' });
    expect(resolved.projectId).toBe('p1');
    expect(resolved.accountId).toBe('acct-1');
    expect(resolved.ownerUserId).toBe('user-1');
  });
});
