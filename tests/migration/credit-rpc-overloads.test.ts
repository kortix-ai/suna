import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb } from '../../packages/db/src/client';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-credit-rpc-overloads-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999 (`/proc/sys/net/ipv4/ip_local_port_range`), and
// an outbound socket from the suite can transiently own a port in it — Docker
// then fails the run with `bind: address already in use`. The previous 554xx
// defaults sat inside that range and flaked CI on two different ports in a
// single run.
const PORT = Number(process.env.CREDIT_RPC_OVERLOADS_TEST_PORT || 5444);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

function psql(sql: string): string {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function psqlAllowError(sql: string): { ok: boolean; stderr: string } {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  return { ok: res.ok, stderr: res.stderr };
}

function pgReady(): boolean {
  return sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres']).ok;
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

/** Every public.atomic_* compatibility wrapper and every kortix_wallet function. */
function atomicOverloads(): OverloadRow[] {
  const raw = psql(
    `select n.nspname || '.' || p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
            (p.pronargs - p.pronargdefaults) || '|' || p.pronargs
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname like 'atomic\\_%') or n.nspname = 'kortix_wallet'
     order by 1`,
  );
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [name, args, minArity, maxArity] = line.split('|');
    return { name, args, minArity: Number(minArity), maxArity: Number(maxArity) };
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

const suite = dockerOk ? describe : describe.skip;

suite('credit RPC overload resolution (throwaway Postgres)', () => {
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

  test('no wallet function has two overloads with overlapping callable arity', () => {
    const collisions = collidingPairs(atomicOverloads());
    expect(collisions).toEqual([]);
  });

  test('atomic_use_credits has exactly one definition', () => {
    const overloads = atomicOverloads().filter((row) => row.name === 'public.atomic_use_credits');
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
  // ─── kortix_wallet storage (20260925013304428) ──────────────────────────────

  test('the wallet schema holds exactly the three wallet functions, one signature each', () => {
    expect(
      atomicOverloads()
        .filter((row) => row.name.startsWith('kortix_wallet.'))
        .map((row) => `${row.name}(${row.args})`),
    ).toEqual([
      'kortix_wallet.debit_credits(p_account_id uuid, p_amount numeric, p_enforce_floor boolean, p_description text, p_ledger_type text, p_idempotency_key text)',
      'kortix_wallet.grant_credits(p_account_id uuid, p_amount numeric, p_is_expiring boolean, p_description text, p_expires_at timestamp with time zone, p_type text, p_stripe_event_id text, p_idempotency_key text)',
      'kortix_wallet.reset_expiring_credits(p_account_id uuid, p_new_credits numeric, p_description text, p_stripe_event_id text)',
    ]);
    // Only the four compatibility wrappers remain in public; the two dead ones are gone.
    expect(atomicOverloads().filter((row) => row.name.startsWith('public.')).map((row) => row.name)).toEqual([
      'public.atomic_add_credits',
      'public.atomic_reset_expiring_credits',
      'public.atomic_settle_credits',
      'public.atomic_use_credits',
    ]);
  });

  test('every wallet function and wrapper pins an empty search_path', () => {
    // A function without a pinned search_path resolves unqualified names through
    // the caller's path, so a caller-owned object could shadow a wallet table.
    const unpinned = psql(
      `select n.nspname || '.' || p.proname || ' ' || coalesce(array_to_string(p.proconfig, ','), '<none>')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'atomic\\_%') or n.nspname = 'kortix_wallet')
         and coalesce(p.proconfig, '{}') <> '{"search_path=\\"\\""}'::text[]
       order by 1`,
    );
    expect(unpinned).toBe('');
    expect(atomicOverloads().length).toBeGreaterThanOrEqual(7);
  });

  test('a NULL floor argument enforces the floor and writes nothing', () => {
    const account = fundedAccount('1');
    const result = psql(
      `select kortix_wallet.debit_credits(p_account_id => '${account}'::uuid, p_amount => 5, p_enforce_floor => null,
              p_description => 'too much', p_ledger_type => 'llm_debit', p_idempotency_key => null) ->> 'error'`,
    );
    expect(result).toBe('Insufficient credits');
    expect(psql(`select balance_precise from kortix.credit_accounts where account_id = '${account}'`)).toBe(
      '1.0000000000',
    );
    expect(psql(`select count(*) from kortix.credit_ledger where account_id = '${account}'`)).toBe('0');
  });

  test('two concurrent admissions cannot both spend the same balance', async () => {
    const account = fundedAccount('10');
    const debit = `select kortix_wallet.debit_credits(p_account_id => '${account}'::uuid, p_amount => 6,
      p_enforce_floor => true, p_description => 'LLM', p_ledger_type => 'llm_debit', p_idempotency_key => null) as r`;
    const first = createDb(url, { max: 1 });
    const second = createDb(url, { max: 1 });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let debited!: () => void;
      const firstDebited = new Promise<void>((resolve) => {
        debited = resolve;
      });
      // The first admission debits and holds its transaction open.
      const firstTx = first.$client.begin(async (tx) => {
        const [row] = await tx.unsafe(debit);
        debited();
        await held;
        return row.r as { success: boolean };
      });
      await firstDebited;
      // The second admission must wait on the account row lock, then see the
      // drained balance. A guard that reads before the lock sees 10 and overdraws.
      const secondTx = second.$client.begin(async (tx) => {
        const [row] = await tx.unsafe(debit);
        return row.r as { success: boolean; error?: string };
      });
      await Bun.sleep(300);
      release();
      const [a, b] = await Promise.all([firstTx, secondTx]);
      expect(a.success).toBe(true);
      expect(b).toMatchObject({ success: false, error: 'Insufficient credits' });
    } finally {
      await first.$client.end({ timeout: 5 });
      await second.$client.end({ timeout: 5 });
    }
    expect(psql(`select balance_precise from kortix.credit_accounts where account_id = '${account}'`)).toBe(
      '4.0000000000',
    );
    expect(psql(`select count(*) from kortix.credit_ledger where account_id = '${account}'`)).toBe('1');
  });

  test('client roles can neither use the wallet schema nor execute any wallet function', () => {
    expect(
      psql(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join (values ('anon'), ('authenticated')) r(role)
         where (n.nspname = 'kortix_wallet' or (n.nspname = 'public' and p.proname like 'atomic\\_%'))
           and has_function_privilege(r.role, p.oid, 'EXECUTE')`,
      ),
    ).toBe('0');
    expect(psql(`select has_schema_privilege('anon', 'kortix_wallet', 'USAGE')`)).toBe('f');
    expect(psql(`select has_schema_privilege('authenticated', 'kortix_wallet', 'USAGE')`)).toBe('f');
    expect(psql(`select has_schema_privilege('service_role', 'kortix_wallet', 'USAGE')`)).toBe('t');
  });

  test('a wrapper writes the same row the wallet function writes', () => {
    const viaWrapper = fundedAccount('10');
    const direct = fundedAccount('10');
    psql(`select public.atomic_settle_credits('${viaWrapper}'::uuid, 12::numeric, 'Compute', 'compute_debit', 'wrap:${viaWrapper}')`);
    psql(
      `select kortix_wallet.debit_credits(p_account_id => '${direct}'::uuid, p_amount => 12, p_enforce_floor => false,
              p_description => 'Compute', p_ledger_type => 'compute_debit', p_idempotency_key => 'wrap:${direct}')`,
    );
    const row = (id: string) =>
      psql(
        `select row_to_json(r) from (select type, amount_precise, balance_after_precise, description, metadata
         from kortix.credit_ledger where account_id = '${id}') r`,
      );
    expect(row(viaWrapper)).toBe(row(direct));
    expect(JSON.parse(row(direct)).metadata).toEqual({
      from_daily: 0,
      from_monthly: 0,
      from_extra: 12,
      ledger_type: 'compute_debit',
      overdraft: true,
    });
  });

  test('the ledger refuses a second row with an idempotency key it already holds', () => {
    const account = fundedAccount('10');
    psql(`insert into kortix.credit_ledger (account_id, type, idempotency_key) values ('${account}', 'purchase', 'dup:${account}')`);
    const second = psqlAllowError(
      `insert into kortix.credit_ledger (account_id, type, idempotency_key) values ('${account}', 'purchase', 'dup:${account}')`,
    );
    expect(second.ok).toBe(false);
    expect(second.stderr).toContain('uniq_credit_ledger_idempotency_key');
    // Rows without a key are outside the index.
    psql(`insert into kortix.credit_ledger (account_id, type) values ('${account}', 'purchase'), ('${account}', 'purchase')`);
  });

  test('two concurrent grants under one request key write one row', async () => {
    const account = fundedAccount('0');
    const grant = `select kortix_wallet.grant_credits(p_account_id => '${account}'::uuid, p_amount => 5,
      p_is_expiring => false, p_description => 'Refund', p_expires_at => null, p_type => 'purchase',
      p_stripe_event_id => null, p_idempotency_key => 'race:${account}')`;
    const first = createDb(url, { max: 1 });
    const second = createDb(url, { max: 1 });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted!: () => void;
      const firstInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      // The first grant inserts its row and holds its transaction open.
      const firstTx = first.$client.begin(async (tx) => {
        await tx.unsafe(grant);
        inserted();
        await held;
      });
      await firstInserted;
      // The second grant's key check cannot see the uncommitted row, so it
      // passes and then waits on the account row lock.
      const secondTx = second.$client.begin((tx) => tx.unsafe(grant)).then(
        () => null,
        (error: { code?: string; constraint_name?: string }) => error,
      );
      await Bun.sleep(300);
      release();
      await firstTx;
      const error = await secondTx;
      expect(error?.code).toBe('23505');
      expect(error?.constraint_name).toBe('uniq_credit_ledger_idempotency_key');
    } finally {
      await first.$client.end({ timeout: 5 });
      await second.$client.end({ timeout: 5 });
    }
    expect(psql(`select count(*) from kortix.credit_ledger where account_id = '${account}'`)).toBe('1');
    expect(psql(`select balance_precise from kortix.credit_accounts where account_id = '${account}'`)).toBe(
      '5.0000000000',
    );
  });
});
