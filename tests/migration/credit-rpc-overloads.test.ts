import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';
import { DisposablePostgres, dockerAvailable } from './disposable-postgres';

const ROOT = repoRoot();
const postgres = new DisposablePostgres(
  'kortix-credit-rpc-overloads-test',
  'CREDIT_RPC_OVERLOADS_TEST_PORT',
);

function psql(sql: string): string {
  const res = sh(['psql', postgres.url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function psqlAllowError(sql: string): { ok: boolean; stderr: string } {
  const res = sh(['psql', postgres.url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  return { ok: res.ok, stderr: res.stderr };
}

function fundedAccount(balance: string): string {
  const id = psql('select gen_random_uuid()');
  psql(
    `insert into kortix.credit_accounts (account_id, non_expiring_credits_precise, balance_precise)
     values ('${id}', ${balance}, ${balance})`,
  );
  return id;
}

interface OverloadRow {
  name: string;
  args: string;
  minArity: number;
  maxArity: number;
}

function atomicOverloads(): OverloadRow[] {
  const raw = psql(
    `select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
            (p.pronargs - p.pronargdefaults) || '|' || p.pronargs
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'atomic\\_%'
     order by p.proname, p.pronargs`,
  );
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [name, args, minArity, maxArity] = line.split('|');
    return {
      name,
      args,
      minArity: Number(minArity),
      maxArity: Number(maxArity),
    };
  });
}

function collidingPairs(rows: OverloadRow[]): string[] {
  const byName = new Map<string, OverloadRow[]>();
  for (const row of rows) {
    const list = byName.get(row.name) ?? [];
    list.push(row);
    byName.set(row.name, list);
  }

  const collisions: string[] = [];
  for (const [name, list] of byName) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const overlapLow = Math.max(a.minArity, b.minArity);
        const overlapHigh = Math.min(a.maxArity, b.maxArity);
        if (overlapLow <= overlapHigh) {
          collisions.push(
            `${name} is ambiguous for ${overlapLow}-${overlapHigh} positional args: ` +
              `(${a.args}) accepts ${a.minArity}-${a.maxArity}, (${b.args}) accepts ${b.minArity}-${b.maxArity}`,
          );
        }
      }
    }
  }
  return collisions;
}

const suite = dockerAvailable ? describe : describe.skip;

suite('credit RPC overload resolution (throwaway Postgres)', () => {
  beforeAll(async () => {
    await postgres.start();
    const code = await runMigrate(ROOT, postgres.ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    postgres.stop();
  });

  test('no public.atomic_* function has two overloads with overlapping callable arity', () => {
    const collisions = collidingPairs(atomicOverloads());
    expect(collisions).toEqual([]);
  });

  test('atomic_use_credits has exactly one definition', () => {
    const overloads = atomicOverloads().filter((row) => row.name === 'atomic_use_credits');
    expect(overloads).toHaveLength(1);
    expect(overloads[0].args).toBe(
      'p_account_id uuid, p_amount numeric, p_description text, p_ledger_type text, p_idempotency_key text',
    );
  });

  test('the four-positional-argument debit that raised 42725 in production now resolves', () => {
    const account = fundedAccount('10');
    const attempt = psqlAllowError(
      `select public.atomic_use_credits('${account}'::uuid, 1.5::numeric, 'Sandbox compute'::text, 'compute_debit'::text)`,
    );
    expect(attempt.stderr).not.toContain('42725');
    expect(attempt.stderr).not.toContain('is not unique');
    expect(attempt.ok).toBe(true);
    expect(
      psql(`select balance_precise from kortix.credit_accounts where account_id = '${account}'`),
    ).toBe('8.5000000000');
  });

  test('a three-positional-argument debit from a pre-rollout pod still works and defaults ledger_type', () => {
    const account = fundedAccount('10');
    const attempt = psqlAllowError(
      `select public.atomic_use_credits('${account}'::uuid, 2::numeric, 'Kortix Web Search'::text)`,
    );
    expect(attempt.ok).toBe(true);
    expect(
      psql(
        `select metadata ->> 'ledger_type' from kortix.credit_ledger
         where account_id = '${account}' and type = 'usage'`,
      ),
    ).toBe('usage');
  });

  test('the debit function is SECURITY DEFINER and refuses to overdraw', () => {
    expect(
      psql(
        `select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'atomic_use_credits'`,
      ),
    ).toBe('t');

    const account = fundedAccount('1');
    const result = psql(
      `select public.atomic_use_credits(p_account_id => '${account}'::uuid, p_amount => 5,
              p_description => 'too much', p_ledger_type => 'llm_debit') ->> 'error'`,
    );
    expect(result).toBe('Insufficient credits');
    expect(
      psql(`select balance_precise from kortix.credit_accounts where account_id = '${account}'`),
    ).toBe('1.0000000000');
  });

  test('a ledger_type passed by name reaches the usage-breakdown metadata key', () => {
    const account = fundedAccount('10');
    psql(
      `select public.atomic_use_credits(p_account_id => '${account}'::uuid, p_amount => 3,
              p_description => 'LLM', p_ledger_type => 'llm_debit')`,
    );
    expect(
      psql(
        `select metadata ->> 'ledger_type' from kortix.credit_ledger
         where account_id = '${account}' and type = 'usage'`,
      ),
    ).toBe('llm_debit');
  });
});
