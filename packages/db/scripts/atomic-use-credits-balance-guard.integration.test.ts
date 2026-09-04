// The overdraft guard inside atomic_use_credits, executed by a REAL PostgreSQL.
//
// This function is the only thing standing between a metering tick and a
// negative wallet. It was hardened twice and tested zero times:
//
//   20260712160001000_atomic_use_credits_balance_guard.sql
//     added `IF v_total < p_amount THEN RETURN ... 'Insufficient credits'`
//     under the existing `FOR UPDATE` row lock.
//   20260730012238065_credit_use_credits_single_overload.sql
//     collapsed two overlapping overloads into one, because the WEAKER of the
//     two (SECURITY INVOKER, no ledger_type, and NO BALANCE GUARD) could be
//     bound by an ordinary four-argument positional call.
//
// So the guard has silently regressed once already, by being bypassed rather
// than by being edited. Every case below runs the SHIPPED migration text — not a
// TypeScript re-description of it — against a disposable server.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

setDefaultTimeout(60_000);

const container = `kortix-credit-guard-${crypto.randomUUID().slice(0, 8)}`;

function psql(sql: string, allowFailure = false, extraArgs: string[] = []) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      ...extraArgs,
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

function scalar(sql: string): string {
  return psql(sql, false, ['-t', '-A']).output.trim();
}

function useCredits(args: string): Record<string, unknown> {
  return JSON.parse(scalar(`SELECT public.atomic_use_credits(${args});`));
}

const ACCOUNT = '00000000-0000-4000-a000-000000000001';

function reseed(daily: string, expiring: string, nonExpiring: string) {
  psql(`
    DELETE FROM kortix.credit_ledger WHERE account_id = '${ACCOUNT}';
    DELETE FROM kortix.credit_accounts WHERE account_id = '${ACCOUNT}';
    INSERT INTO kortix.credit_accounts(
      account_id, daily_credits_balance_precise, expiring_credits_precise,
      non_expiring_credits_precise, balance_precise
    ) VALUES (
      '${ACCOUNT}', ${daily}, ${expiring}, ${nonExpiring},
      ${daily} + ${expiring} + ${nonExpiring}
    );
  `);
}

function balance(): number {
  return Number(
    scalar(
      `SELECT balance_precise FROM kortix.credit_accounts WHERE account_id = '${ACCOUNT}';`,
    ),
  );
}

function ledgerRowCount(): number {
  return Number(
    scalar(`SELECT count(*) FROM kortix.credit_ledger WHERE account_id = '${ACCOUNT}';`),
  );
}

describe.skipIf(!dockerAvailable)('atomic_use_credits overdraft guard — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = Bun.spawnSync(
        // OVER TCP (-h), never the default unix socket. The postgres image runs
        // a TEMPORARY server during initdb that listens on the SOCKET ONLY, so
        // a socket probe goes green while that one is up — and the real
        // server's restart then fails the very next statement with
        // "connection to server on socket ... No such file or directory".
        // A TCP probe cannot see the temporary server at all, so passing it
        // means the real one is up.
        [
          'docker',
          'exec',
          container,
          'psql',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'testdb',
          '-c',
          'SELECT 1',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    // Only the tables the function touches, with the columns it names. Every
    // balance column is NULLABLE exactly as in production, because the function
    // COALESCEs them and a NOT NULL here would hide a defect in that COALESCE.
    psql(`
      CREATE ROLE service_role;
      CREATE ROLE authenticated;
      CREATE SCHEMA kortix;
      CREATE TABLE kortix.credit_accounts (
        account_id uuid PRIMARY KEY,
        daily_credits_balance_precise numeric(20,10),
        expiring_credits_precise numeric(20,10),
        non_expiring_credits_precise numeric(20,10),
        balance_precise numeric(20,10),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE kortix.credit_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL,
        amount numeric(12,4) NOT NULL DEFAULT 0,
        amount_precise numeric(20,10) NOT NULL DEFAULT 0,
        balance_after numeric(12,4) NOT NULL DEFAULT 0,
        balance_after_precise numeric(20,10) NOT NULL DEFAULT 0,
        type text NOT NULL,
        description text,
        metadata jsonb DEFAULT '{}'::jsonb,
        idempotency_key text,
        created_at timestamptz DEFAULT now()
      );
      CREATE INDEX idx_credit_ledger_idempotency ON kortix.credit_ledger(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    // The CURRENT shipped definition, verbatim. Reading it from the migration
    // file is the point: a future migration that replaces the function without
    // carrying the guard forward fails these tests instead of passing them.
    const migration = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        'migrations',
        '20260805175409752_credit_use_credits_idempotency.sql',
      ),
    ).text();
    const functionText = migration.slice(migration.indexOf('DROP FUNCTION IF EXISTS'));
    if (!functionText.includes("IF v_total < p_amount THEN")) {
      throw new Error(
        'the shipped atomic_use_credits no longer contains the balance guard — this test is the alarm',
      );
    }
    psql(functionText);
  });

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('refuses a debit larger than the balance and reports what was available', () => {
    reseed('0', '10', '0');
    const result = useCredits(`'${ACCOUNT}'::uuid, 25::numeric, 'Overdraft attempt', 'llm_debit'`);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Insufficient credits');
    expect(Number(result.required)).toBe(25);
    expect(Number(result.available)).toBe(10);
  });

  test('a refused debit moves no money and writes no ledger row', () => {
    reseed('0', '10', '0');
    useCredits(`'${ACCOUNT}'::uuid, 25::numeric, 'Overdraft attempt', 'llm_debit'`);

    expect(balance()).toBe(10);
    expect(ledgerRowCount()).toBe(0);
  });

  test('refuses a debit one cent over the balance', () => {
    reseed('0', '10', '0');
    const result = useCredits(`'${ACCOUNT}'::uuid, 10.01::numeric, 'One cent over', 'llm_debit'`);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Insufficient credits');
    expect(balance()).toBe(10);
  });

  test('allows a debit for exactly the balance and drains the wallet to zero', () => {
    reseed('0', '10', '0');
    const result = useCredits(`'${ACCOUNT}'::uuid, 10::numeric, 'Exact drain', 'llm_debit'`);

    expect(result.success).toBe(true);
    expect(Number(result.amount_deducted)).toBe(10);
    expect(Number(result.new_total)).toBe(0);
    expect(balance()).toBe(0);
    expect(ledgerRowCount()).toBe(1);
  });

  test('the guard sums all three buckets, not just the one being spent', () => {
    reseed('1', '2', '3');
    const ok = useCredits(`'${ACCOUNT}'::uuid, 6::numeric, 'Spans all buckets', 'compute_debit'`);
    expect(ok.success).toBe(true);
    expect(Number(ok.from_daily)).toBe(1);
    expect(Number(ok.from_monthly)).toBe(2);
    expect(Number(ok.from_extra)).toBe(3);

    reseed('1', '2', '3');
    const over = useCredits(`'${ACCOUNT}'::uuid, 6.5::numeric, 'One over', 'compute_debit'`);
    expect(over.success).toBe(false);
    expect(Number(over.available)).toBe(6);
  });

  test('refuses a non-positive amount before touching the wallet', () => {
    reseed('0', '10', '0');
    for (const amount of ['0', '-5']) {
      const result = useCredits(`'${ACCOUNT}'::uuid, ${amount}::numeric, 'Bad amount', 'usage'`);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Amount must be positive');
    }
    expect(balance()).toBe(10);
    expect(ledgerRowCount()).toBe(0);
  });

  test('refuses an account that has no credit account row', () => {
    psql(`DELETE FROM kortix.credit_accounts WHERE account_id = '${ACCOUNT}';`);
    const result = useCredits(`'${ACCOUNT}'::uuid, 1::numeric, 'No account', 'usage'`);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No credit account found');
  });

  test('sequential debits cannot walk the balance negative', () => {
    reseed('0', '10', '0');
    for (let i = 0; i < 5; i += 1) {
      useCredits(`'${ACCOUNT}'::uuid, 3::numeric, 'Tick ${i}', 'compute_debit'`);
    }

    expect(balance()).toBe(1);
    expect(ledgerRowCount()).toBe(3);
  });

  test('a replayed idempotency key succeeds without debiting twice', () => {
    reseed('0', '10', '0');
    const first = useCredits(
      `'${ACCOUNT}'::uuid, 4::numeric, 'Metered window', 'compute_debit', 'window-1'`,
    );
    const second = useCredits(
      `'${ACCOUNT}'::uuid, 4::numeric, 'Metered window', 'compute_debit', 'window-1'`,
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.transaction_id).toBe(first.transaction_id);
    expect(balance()).toBe(6);
    expect(ledgerRowCount()).toBe(1);
  });

  test('every written debit row stamps its granular kind into metadata', () => {
    reseed('0', '10', '0');
    useCredits(`'${ACCOUNT}'::uuid, 1::numeric, 'LLM call', 'llm_debit'`);

    expect(
      scalar(
        `SELECT metadata ->> 'ledger_type' FROM kortix.credit_ledger WHERE account_id = '${ACCOUNT}';`,
      ),
    ).toBe('llm_debit');
  });
});
