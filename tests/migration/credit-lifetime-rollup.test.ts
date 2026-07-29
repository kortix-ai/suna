import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-lifetime-rollup-test';
const PORT = Number(process.env.LIFETIME_ROLLUP_TEST_PORT || 55441);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

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

function ledger(accountId: string, amount: string, type: string): void {
  psql(
    `insert into kortix.credit_ledger (account_id, amount_precise, type) values ('${accountId}', ${amount}, '${type}')`,
  );
}

function lifetime(accountId: string): {
  granted: number;
  purchased: number;
  used: number;
  legacyGranted: number;
} {
  const row = psql(
    `select lifetime_granted_precise, lifetime_purchased_precise, lifetime_used_precise, lifetime_granted
     from kortix.credit_accounts where account_id = '${accountId}'`,
  ).split('|');
  return {
    granted: Number(row[0]),
    purchased: Number(row[1]),
    used: Number(row[2]),
    legacyGranted: Number(row[3]),
  };
}

const suite = dockerOk ? describe : describe.skip;

suite('credit_accounts lifetime_* rollup (throwaway Postgres)', () => {
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

  test('a tier grant increments lifetime_granted, not purchased or used', () => {
    const account = newAccount();
    ledger(account, '25', 'tier_grant');
    expect(lifetime(account)).toMatchObject({ granted: 25, purchased: 0, used: 0 });
  });

  test('a purchase increments lifetime_purchased, never lifetime_granted', () => {
    const account = newAccount();
    ledger(account, '20', 'purchase');
    expect(lifetime(account)).toMatchObject({ granted: 0, purchased: 20, used: 0 });
  });

  test('a usage debit (stored negative) increments lifetime_used as a positive figure', () => {
    const account = newAccount();
    ledger(account, '-3.25', 'usage');
    expect(lifetime(account).used).toBeCloseTo(3.25, 6);
  });

  test('a refund nets against lifetime_used instead of inflating lifetime_granted', () => {
    const account = newAccount();
    ledger(account, '-5', 'usage');
    ledger(account, '2', 'llm_reservation_refund');
    const totals = lifetime(account);
    expect(totals.used).toBeCloseTo(3, 6);
    expect(totals.granted).toBe(0);
  });

  test('an unrecognised positive ledger type counts as a grant rather than being dropped', () => {
    const account = newAccount();
    ledger(account, '7', 'some_future_grant_type');
    expect(lifetime(account).granted).toBe(7);
  });

  test('a month of mixed activity rolls up to the ledger totals', () => {
    const account = newAccount();
    ledger(account, '2', 'free_tier_grant');
    ledger(account, '25', 'tier_grant');
    ledger(account, '20', 'purchase');
    for (let i = 0; i < 10; i++) ledger(account, '-1.5', 'usage');
    ledger(account, '0.5', 'compute_refund');
    const totals = lifetime(account);
    expect(totals.granted).toBe(27);
    expect(totals.purchased).toBe(20);
    expect(totals.used).toBeCloseTo(14.5, 6);
  });

  test('the legacy numeric(12,4) column is mirrored from the precise one', () => {
    const account = newAccount();
    ledger(account, '25', 'tier_grant');
    expect(lifetime(account).legacyGranted).toBe(25);
  });

  test('recompute repairs a rollup that has drifted from the ledger, and is idempotent', () => {
    const account = newAccount();
    ledger(account, '25', 'tier_grant');
    ledger(account, '-4', 'usage');
    psql(
      `update kortix.credit_accounts set lifetime_granted_precise = 999, lifetime_used_precise = 0 where account_id = '${account}'`,
    );

    const repaired = Number(psql(`select kortix.recompute_credit_account_lifetime('${account}')`));
    expect(repaired).toBe(1);
    expect(lifetime(account)).toMatchObject({ granted: 25, used: 4 });

    const secondRun = Number(psql(`select kortix.recompute_credit_account_lifetime('${account}')`));
    expect(secondRun).toBe(0);
  });

  test('an account with no ledger history stays at zero', () => {
    const account = newAccount();
    psql('select kortix.recompute_credit_account_lifetime(null)');
    expect(lifetime(account)).toMatchObject({ granted: 0, purchased: 0, used: 0 });
  });
});

if (!dockerOk) {
  test.skip('credit lifetime rollup (docker unavailable — skipped)', () => {});
}
