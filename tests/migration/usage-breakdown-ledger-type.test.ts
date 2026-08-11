import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createDb } from '../../packages/db/src/client';
import { repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';
import { DisposablePostgres, dockerAvailable } from './disposable-postgres';

const ROOT = repoRoot();
const postgres = new DisposablePostgres('kortix-usage-breakdown-test', 'USAGE_BREAKDOWN_TEST_PORT');
let getUsageBreakdownThisPeriod: typeof import(
  '../../apps/api/src/billing/services/usage-breakdown',
).getUsageBreakdownThisPeriod;

const PERIOD_START = '2026-07-01T00:00:00.000Z';

function psql(sql: string): string {
  const res = sh(['psql', postgres.url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function newAccount(): string {
  const id = psql('select gen_random_uuid()');
  psql(`insert into kortix.credit_accounts (account_id) values ('${id}')`);
  return id;
}

function rpcDebit(accountId: string, amount: string, ledgerType: string, createdAt = PERIOD_START) {
  psql(
    `insert into kortix.credit_ledger (account_id, amount_precise, type, description, metadata, created_at)
     values ('${accountId}', ${amount}, 'usage', 'Sandbox compute',
             jsonb_build_object('from_daily', 0, 'from_extra', 0, 'from_monthly', ${amount.replace('-', '')}, 'ledger_type', '${ledgerType}'),
             '${createdAt}')`,
  );
}

function rawLedger(
  accountId: string,
  amount: string,
  type: string,
  createdAt = PERIOD_START,
): void {
  psql(
    `insert into kortix.credit_ledger (account_id, amount_precise, type, created_at)
     values ('${accountId}', ${amount}, '${type}', '${createdAt}')`,
  );
}

const suite = dockerAvailable ? describe : describe.skip;

suite('usage breakdown reads metadata->>ledger_type (throwaway Postgres)', () => {
  beforeAll(async () => {
    await postgres.start();
    mock.module('../../apps/api/src/shared/db', () => ({
      hasDatabase: true,
      db: createDb(postgres.url),
    }));
    ({ getUsageBreakdownThisPeriod } = await import(
      '../../apps/api/src/billing/services/usage-breakdown'
    ));
    const code = await runMigrate(ROOT, postgres.ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    postgres.stop();
  });

  test('a production-shaped compute debit lands in compute_usd', async () => {
    const account = newAccount();
    rpcDebit(account, '-0.2', 'compute_debit');

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown.compute_usd).toBeCloseTo(0.2, 6);
    expect(breakdown.llm_usd).toBe(0);
    expect(breakdown.total_usd).toBeCloseTo(0.2, 6);
  });

  test('a production-shaped LLM debit lands in llm_usd', async () => {
    const account = newAccount();
    rpcDebit(account, '-1.25', 'llm_debit');

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown.llm_usd).toBeCloseTo(1.25, 6);
    expect(breakdown.compute_usd).toBe(0);
  });

  test('atomic_use_credits output is classified without any test-side shaping', async () => {
    const account = newAccount();
    psql(
      `update kortix.credit_accounts
       set non_expiring_credits_precise = 50, balance_precise = 50
       where account_id = '${account}'`,
    );
    psql(
      `select public.atomic_use_credits(p_account_id => '${account}'::uuid, p_amount => 3.5,
              p_description => 'Sandbox compute', p_ledger_type => 'compute_debit')`,
    );
    psql(
      `select public.atomic_use_credits(p_account_id => '${account}'::uuid, p_amount => 1.5,
              p_description => 'LLM', p_ledger_type => 'llm_debit')`,
    );

    const breakdown = await getUsageBreakdownThisPeriod(account, null);

    expect(breakdown.compute_usd).toBeCloseTo(3.5, 6);
    expect(breakdown.llm_usd).toBeCloseTo(1.5, 6);
    expect(breakdown.total_usd).toBeCloseTo(5, 6);
  });

  test('a legacy row carrying the granular kind on type still classifies', async () => {
    const account = newAccount();
    rawLedger(account, '-4', 'compute_debit');
    rawLedger(account, '-2', 'token_overage');

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown.compute_usd).toBeCloseTo(4, 6);
    expect(breakdown.llm_usd).toBeCloseTo(2, 6);
  });

  test('grants and refunds never count as spend', async () => {
    const account = newAccount();
    rawLedger(account, '25', 'tier_grant');
    rawLedger(account, '2', 'free_tier_grant');
    rawLedger(account, '1', 'tool_reservation_refund');
    rpcDebit(account, '-0.5', 'compute_debit');

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown.total_usd).toBeCloseTo(0.5, 6);
  });

  test('debits written before the period start are excluded', async () => {
    const account = newAccount();
    rpcDebit(account, '-9', 'compute_debit', '2026-06-01T00:00:00.000Z');
    rpcDebit(account, '-1', 'compute_debit');

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown.compute_usd).toBeCloseTo(1, 6);
  });

  test('an account with no debits reports zeroes rather than failing', async () => {
    const account = newAccount();

    const breakdown = await getUsageBreakdownThisPeriod(account, PERIOD_START);

    expect(breakdown).toMatchObject({
      compute_usd: 0,
      llm_usd: 0,
      total_usd: 0,
    });
  });
});

if (!dockerAvailable) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('usage breakdown ledger_type (docker unavailable — skipped)', () => {});
}
