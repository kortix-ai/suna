import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = `kortix-lifetime-rollup-test-${process.pid}`;
// Docker claims one fixed candidate atomically. Candidates stay below Linux's
// 32768-60999 ephemeral range, where transient outbound sockets made prior
// 554xx defaults and Docker-assigned ports unsafe for this migration test.
const PORT_OVERRIDE = process.env.LIFETIME_ROLLUP_TEST_PORT
  ? Number(process.env.LIFETIME_ROLLUP_TEST_PORT)
  : null;
let port = PORT_OVERRIDE ?? 0;
const ROOT = repoRoot();

function defaultPortCandidates(pid: number): number[] {
  const floor = 20_000;
  const range = 10_000;
  const start = Math.abs(pid) % range;
  return Array.from({ length: 100 }, (_, offset) => floor + ((start + offset) % range));
}

function postgresRunArgs(hostPort: number): string[] {
  return [
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
    `127.0.0.1:${hostPort}:5432`,
    'postgres:16-alpine',
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
  ];
}

function startPostgres(): void {
  const candidates = PORT_OVERRIDE === null ? defaultPortCandidates(process.pid) : [PORT_OVERRIDE];
  let lastBindFailure = '';

  for (const candidate of candidates) {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh(postgresRunArgs(candidate));
    if (up.ok) {
      port = candidate;
      return;
    }

    sh(['docker', 'rm', '-f', CONTAINER]);
    const detail = `${up.stdout}\n${up.stderr}`.trim();
    const bindFailed = /address already in use|port is already allocated|bind for .* failed/i.test(detail);
    if (PORT_OVERRIDE !== null || !bindFailed) {
      throw new Error(`could not start test container on port ${candidate}: ${detail}`);
    }
    lastBindFailure = detail;
  }

  throw new Error(`could not claim a test port after ${candidates.length} attempts: ${lastBindFailure}`);
}

function migrationPorts(): Ports {
  return { ...computePorts(0), sbDb: port };
}

function postgresUrl(): string {
  return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}

function psql(sql: string): string {
  const res = sh(['psql', postgresUrl(), '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres']).ok;
}

async function waitForPostgres(
  ready: () => boolean,
  sleep: (milliseconds: number) => Promise<unknown>,
  attempts = 60,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (ready()) return true;
    await sleep(1000);
  }
  return false;
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

test('the successful readiness probe is not discarded by a second probe', async () => {
  const outcomes = [false, true, false];
  let probes = 0;

  const ready = await waitForPostgres(
    () => outcomes[probes++] ?? false,
    async () => {},
  );

  expect(ready).toBe(true);
  expect(probes).toBe(2);
});

test('the container is process-scoped and default ports avoid the ephemeral range', () => {
  const candidates = defaultPortCandidates(process.pid);

  expect(CONTAINER).toBe(`kortix-lifetime-rollup-test-${process.pid}`);
  expect(candidates).toHaveLength(100);
  expect(new Set(candidates)).toHaveLength(100);
  expect(candidates.every((port) => port >= 20_000 && port < 30_000)).toBe(true);
});

suite('credit_accounts lifetime_* rollup (throwaway Postgres)', () => {
  beforeAll(async () => {
    startPostgres();
    if (!(await waitForPostgres(pgReady, (milliseconds) => Bun.sleep(milliseconds)))) {
      throw new Error('test Postgres never became ready');
    }
    const code = await runMigrate(ROOT, migrationPorts());
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

  test('the rollup functions carry explicit EXECUTE grants for service_role', () => {
    const acl = psql(
      `select proname || ':' || (aclexplode(proacl)).grantee::regrole::text
       from pg_proc
       where pronamespace = 'kortix'::regnamespace
         and proname in ('credit_ledger_lifetime_deltas', 'apply_credit_ledger_lifetime_rollup', 'recompute_credit_account_lifetime')`,
    );
    expect(acl).toContain('credit_ledger_lifetime_deltas:service_role');
    expect(acl).toContain('apply_credit_ledger_lifetime_rollup:service_role');
    expect(acl).toContain('recompute_credit_account_lifetime:service_role');
  });

  test('a service_role ledger insert fires the trigger without PUBLIC function EXECUTE (Supabase parity)', () => {
    // Supabase revokes the default PUBLIC EXECUTE on functions; plain Postgres
    // does not, which is how the missing grants shipped. Recreate that
    // environment, then write the ledger as service_role through the trigger.
    const account = newAccount();
    psql(
      'revoke execute on function kortix.credit_ledger_lifetime_deltas(numeric, text) from public',
    );
    psql('revoke execute on function kortix.apply_credit_ledger_lifetime_rollup() from public');
    psql(
      `set role service_role;
       insert into kortix.credit_ledger (account_id, amount_precise, type) values ('${account}', 25, 'tier_grant');
       reset role`,
    );
    expect(lifetime(account)).toMatchObject({ granted: 25, purchased: 0, used: 0 });
  });
});

if (!dockerOk) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('credit lifetime rollup (docker unavailable — skipped)', () => {});
}
