import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createDb } from '../../packages/db/src/client';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-usage-breakdown-test';
const PORT = Number(process.env.USAGE_BREAKDOWN_TEST_PORT || 55443);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

mock.module('../../apps/api/src/shared/db', () => ({
  hasDatabase: true,
  db: createDb(url),
}));

const { getUsageBreakdownThisPeriod } = await import(
  '../../apps/api/src/billing/services/usage-breakdown'
);

const PERIOD_START = '2026-07-01T00:00:00.000Z';

function psql(sql: string): string {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres']).ok;
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

const suite = dockerOk ? describe : describe.skip;

suite('usage breakdown reads metadata->>ledger_type (throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker',
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60; i++) {
      if (pgReady()) break;
      await Bun.sleep(1000);
    }
    if (!pgReady()) throw new Error('test Postgres never became ready');
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
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

    expect(breakdown).toMatchObject({ compute_usd: 0, llm_usd: 0, total_usd: 0 });
  });
});

if (!dockerOk) {
  test.skip('usage breakdown ledger_type (docker unavailable — skipped)', () => {});
}
