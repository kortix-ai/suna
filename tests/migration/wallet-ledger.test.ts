// Characterization of every credit-wallet write against a real, fully migrated
// PostgreSQL: the exact `credit_ledger` row and `credit_accounts` buckets each
// operation leaves behind, its replay behaviour, and its refusal behaviour.
//
// The API code under test is imported for real and runs its real SQL. Only the
// transport is substituted: the PostgREST RPC endpoint the pre-wallet code
// called is emulated by `postgrestRpc` below, which invokes the same SQL
// function with the same named arguments.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { spawn } from 'bun';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-wallet-ledger-test';
// Below 32768 for the reason given in credit-rpc-overloads.test.ts.
const PORT = Number(process.env.WALLET_LEDGER_TEST_PORT || 5446);
const ROOT = repoRoot();
const API = `${ROOT}/apps/api/src`;
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

function psql(query: string): string {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', query]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${query}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres']).ok;
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const RPC_ARG_TYPES: Record<string, string> = {
  p_account_id: 'uuid',
  p_amount: 'numeric',
  p_new_credits: 'numeric',
  p_is_expiring: 'boolean',
  p_expires_at: 'timestamptz',
};

/** PostgREST `rpc()` stand-in: same function, same named arguments, same `{data,error}` envelope. */
async function postgrestRpc(name: string, params: Record<string, unknown>) {
  const args = Object.entries(params).map(([key, value]) => {
    const literal = value === null || value === undefined ? 'NULL' : quote(String(value));
    return `${key} => ${literal}::${RPC_ARG_TYPES[key] ?? 'text'}`;
  });
  const proc = spawn(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', `select public.${name}(${args.join(', ')})`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const message = stderr.replace(/^ERROR:\s+/m, '').split('\n')[0] ?? stderr;
    return { data: null, error: { message, code: /duplicate key/.test(message) ? '23505' : 'P0001' } };
  }
  return { data: JSON.parse(stdout.trim()), error: null };
}

type Buckets = { daily?: number; expiring?: number; nonExpiring?: number };

function newAccount(buckets: Buckets = {}): string {
  const id = psql('select gen_random_uuid()');
  const daily = buckets.daily ?? 0;
  const expiring = buckets.expiring ?? 0;
  const nonExpiring = buckets.nonExpiring ?? 0;
  psql(
    `insert into kortix.credit_accounts
       (account_id, daily_credits_balance_precise, expiring_credits_precise, non_expiring_credits_precise, balance_precise, tier)
     values ('${id}', ${daily}, ${expiring}, ${nonExpiring}, ${daily + expiring + nonExpiring}, 'free')`,
  );
  return id;
}

function unknownAccount(): string {
  return psql('select gen_random_uuid()');
}

interface LedgerRow {
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  is_expiring: boolean | null;
  expires_at: string | null;
  stripe_event_id: string | null;
  idempotency_key: string | null;
  processing_source: string | null;
  metadata: Record<string, unknown>;
}

function ledger(accountId: string): LedgerRow[] {
  const raw = psql(
    `select coalesce(json_agg(r order by r.created_at, r.id), '[]') from (
       select id, created_at, type, amount_precise::float8 as amount, balance_after_precise::float8 as balance_after,
              description, is_expiring, expires_at, stripe_event_id, idempotency_key, processing_source, metadata
       from kortix.credit_ledger where account_id = '${accountId}') r`,
  );
  return (JSON.parse(raw) as Array<LedgerRow & { id: string; created_at: string }>).map(
    ({ id: _id, created_at: _createdAt, ...row }) => row,
  );
}

interface AccountRow {
  balance: number;
  expiring: number;
  non_expiring: number;
  daily: number;
  tier: string | null;
}

function account(accountId: string): AccountRow | null {
  const raw = psql(
    `select row_to_json(r) from (
       select balance_precise::float8 as balance, expiring_credits_precise::float8 as expiring,
              non_expiring_credits_precise::float8 as non_expiring, daily_credits_balance_precise::float8 as daily, tier
       from kortix.credit_accounts where account_id = '${accountId}') r`,
  );
  return raw ? (JSON.parse(raw) as AccountRow) : null;
}

const suite = dockerOk ? describe : describe.skip;

suite('credit wallet ledger writes (throwaway Postgres)', () => {
  // The API modules are imported only after the database exists, because
  // `apps/api/src/config` validates the environment at import time.
  let credits: typeof import('../../apps/api/src/billing/services/credits');
  let settlement: typeof import('../../apps/api/src/billing/services/settle-credits');
  let transactions: typeof import('../../apps/api/src/billing/repositories/transactions');
  let creditAccounts: typeof import('../../apps/api/src/billing/repositories/credit-accounts');
  let router: typeof import('../../apps/api/src/router/services/billing');
  let errors: typeof import('../../apps/api/src/errors');

  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker', 'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql/data', '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60; i++) {
      if (pgReady()) break;
      await Bun.sleep(1000);
    }
    if (!pgReady()) throw new Error('test Postgres never became ready');
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');

    Object.assign(process.env, {
      DATABASE_URL: url,
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_SERVICE_ROLE_KEY: 'wallet-ledger-test',
      API_KEY_SECRET: 'wallet-ledger-test-api-key-secret',
      TUNNEL_SIGNING_SECRET: 'wallet-ledger-test-tunnel-secret',
      KORTIX_BILLING_INTERNAL_ENABLED: 'true',
      INTERNAL_KORTIX_ENV: 'staging',
      STRIPE_SECRET_KEY: 'sk_test_wallet_ledger',
      STRIPE_WEBHOOK_SECRET: 'whsec_wallet_ledger',
      KORTIX_URL: 'http://127.0.0.1:1',
      DAYTONA_API_KEY: 'wallet-ledger-test',
      DAYTONA_SERVER_URL: 'http://127.0.0.1:1',
      DAYTONA_TARGET: 'us',
    });
    mock.module(`${API}/shared/supabase`, () => ({
      getSupabase: () => ({ rpc: postgrestRpc }),
      toPublicStorageUrl: (value: string) => value,
    }));
    credits = await import('../../apps/api/src/billing/services/credits');
    settlement = await import('../../apps/api/src/billing/services/settle-credits');
    transactions = await import('../../apps/api/src/billing/repositories/transactions');
    creditAccounts = await import('../../apps/api/src/billing/repositories/credit-accounts');
    router = await import('../../apps/api/src/router/services/billing');
    errors = await import('../../apps/api/src/errors');
  }, 300_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  describe('grant', () => {
    test('an expiring grant keyed by an external event lands in the expiring bucket and records the key twice', async () => {
      const id = newAccount({ expiring: 10, nonExpiring: 5 });
      await credits.grantCredits(id, 50, 'tier_grant', 'Plan activated', true, 'subscription_activation:sub_1');
      expect(ledger(id)).toEqual([
        {
          type: 'tier_grant',
          amount: 50,
          balance_after: 65,
          description: 'Plan activated',
          is_expiring: true,
          expires_at: null,
          stripe_event_id: 'subscription_activation:sub_1',
          idempotency_key: `grant:${id}:subscription_activation:sub_1`,
          processing_source: 'atomic_function',
          metadata: {},
        },
      ]);
      expect(account(id)).toEqual({ balance: 65, expiring: 60, non_expiring: 5, daily: 0, tier: 'free' });
    });

    test('a replayed event key writes nothing and moves no money', async () => {
      const id = newAccount();
      await credits.grantCredits(id, 20, 'purchase', 'Credit purchase', false, 'cs_replay');
      const replay = await credits.grantCredits(id, 20, 'purchase', 'Credit purchase', false, 'cs_replay');
      expect(replay).toMatchObject({ success: true, duplicate_prevented: true });
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 20, non_expiring: 20 });
    });

    test('concurrent grants under one event key apply once', async () => {
      const id = newAccount();
      await Promise.all(
        Array.from({ length: 4 }, () =>
          credits.grantCredits(id, 7, 'purchase', 'Auto-topup', false, 'pi_concurrent'),
        ),
      );
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 7, non_expiring: 7 });
    });

    test('an unkeyed grant applies every time it is called', async () => {
      const id = newAccount();
      await credits.grantCredits(id, 3, 'admin_grant', 'Goodwill (by admin x)', false);
      await credits.grantCredits(id, 3, 'admin_grant', 'Goodwill (by admin x)', false);
      const rows = ledger(id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ type: 'admin_grant', amount: 3, is_expiring: false, stripe_event_id: null, idempotency_key: null });
      expect(account(id)).toMatchObject({ balance: 6, non_expiring: 6 });
    });

    test('a negative operator correction reduces the non-expiring bucket', async () => {
      const id = newAccount({ expiring: 4, nonExpiring: 10 });
      await credits.grantCredits(id, -6, 'admin_debit', 'Correction (by admin x)', false);
      expect(ledger(id)).toEqual([
        expect.objectContaining({ type: 'admin_debit', amount: -6, balance_after: 8, is_expiring: false }),
      ]);
      expect(account(id)).toMatchObject({ balance: 8, expiring: 4, non_expiring: 4 });
    });

    test('a grant carries its expiry stamp', async () => {
      const id = newAccount();
      await credits.grantCredits(id, 25, 'trial_grant', 'Trial grant', true, undefined, {
        expiresAt: '2030-01-31T00:00:00.000Z',
      });
      const [row] = ledger(id);
      expect(new Date(row!.expires_at!).toISOString()).toBe('2030-01-31T00:00:00.000Z');
      expect(row).toMatchObject({ type: 'trial_grant', is_expiring: true, stripe_event_id: null, idempotency_key: null });
    });

    test('a grant keyed by an internal request records the key once, without an event id', async () => {
      const id = newAccount();
      await credits.grantCredits(id, 0.004, 'llm_reservation_refund', 'LLM hold refund', false, undefined, {
        idempotencyKey: 'llm-hold-refund:req_1',
      });
      await credits.grantCredits(id, 0.004, 'llm_reservation_refund', 'LLM hold refund', false, undefined, {
        idempotencyKey: 'llm-hold-refund:req_1',
      });
      expect(ledger(id)).toEqual([
        {
          type: 'llm_reservation_refund',
          amount: 0.004,
          balance_after: 0.004,
          description: 'LLM hold refund',
          is_expiring: false,
          expires_at: null,
          stripe_event_id: null,
          idempotency_key: 'llm-hold-refund:req_1',
          processing_source: 'atomic_function',
          metadata: {},
        },
      ]);
    });

    test('a request-keyed grant replayed after an hour applies again', async () => {
      const id = newAccount();
      const grant = () =>
        credits.grantCredits(id, 25, 'trial_grant', 'Trial monthly re-grant', true, undefined, {
          idempotencyKey: `trial_regrant_${id}_1`,
        });
      await grant();
      psql(`update kortix.credit_ledger set created_at = now() - interval '2 hours' where account_id = '${id}'`);
      await grant();
      expect(ledger(id)).toHaveLength(2);
    });

    test('a grant to an account without a credit row creates the row', async () => {
      const id = unknownAccount();
      await credits.grantCredits(id, 2, 'free_tier_grant', 'Free tier welcome credits', true, `free_tier_signup:${id}`);
      expect(account(id)).toEqual({ balance: 2, expiring: 2, non_expiring: 0, daily: 0, tier: 'none' });
      expect(ledger(id)).toHaveLength(1);
    });
  });

  describe('debit (admission)', () => {
    test('drains daily, then expiring, then non-expiring, and labels the row usage', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 3 });
      const result = await credits.deductCredits(id, 2.5, 'LLM gateway admission hold', 'llm_debit');
      const rows = ledger(id);
      expect(rows).toEqual([
        {
          type: 'usage',
          amount: -2.5,
          balance_after: 3.5,
          description: 'LLM gateway admission hold',
          is_expiring: true,
          expires_at: null,
          stripe_event_id: null,
          idempotency_key: null,
          processing_source: null,
          metadata: { from_daily: 1, from_monthly: 1.5, from_extra: 0, ledger_type: 'llm_debit' },
        },
      ]);
      expect(account(id)).toMatchObject({ balance: 3.5, daily: 0, expiring: 0.5, non_expiring: 3 });
      expect(result).toMatchObject({ success: true, cost: 2.5, newBalance: 3.5 });
      expect(typeof result.transactionId).toBe('string');
    });

    test('refuses a debit the balance cannot cover and writes nothing', async () => {
      const id = newAccount({ nonExpiring: 1 });
      const error = await credits.deductCredits(id, 5, 'Agent run usage').catch((err) => err);
      expect(error).toBeInstanceOf(errors.InsufficientCreditsError);
      expect(error.message).toBe('Insufficient credits. Balance: $1.0000, required: $5.0000');
      expect(ledger(id)).toEqual([]);
      expect(account(id)).toMatchObject({ balance: 1, non_expiring: 1 });
    });

    test('refuses a debit for an account without a credit row', async () => {
      const error = await credits.deductCredits(unknownAccount(), 1, 'Agent run usage').catch((err) => err);
      expect(error).toBeInstanceOf(errors.InsufficientCreditsError);
    });

    test('a keyed debit replays instead of charging twice', async () => {
      const id = newAccount({ nonExpiring: 10 });
      const first = await credits.deductCredits(id, 4, 'Metered', 'usage', 'debit:1');
      const second = await credits.deductCredits(id, 4, 'Metered', 'usage', 'debit:1');
      expect(second.transactionId).toBe(first.transactionId);
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 6 });
    });

    test('rejects a non-usage ledger kind before any write', async () => {
      const id = newAccount({ nonExpiring: 10 });
      await expect(credits.deductCredits(id, 1, 'x', 'admin_debit' as never)).rejects.toThrow();
      expect(ledger(id)).toEqual([]);
    });

    test('the router debit reports a refusal as a result, not a throw', async () => {
      const id = newAccount({ nonExpiring: 0.5 });
      expect(await router.deductLLMCredits(id, 'model-x', 10, 20, 1)).toEqual({
        success: false,
        cost: 0,
        newBalance: 0,
        error: 'Insufficient credits',
      });
      expect(await router.deductLLMCredits(unknownAccount(), 'model-x', 10, 20, 1)).toMatchObject({
        success: false,
        error: 'No credit account found',
      });
      expect(ledger(id)).toEqual([]);
    });

    test('the router debit writes an llm_debit usage row', async () => {
      const id = newAccount({ nonExpiring: 2 });
      const result = await router.deductLLMCredits(id, 'model-x', 10, 20, 0.25);
      expect(result).toMatchObject({ success: true, cost: 0.25, newBalance: 1.75 });
      expect(ledger(id)).toEqual([
        expect.objectContaining({
          type: 'usage',
          amount: -0.25,
          description: 'LLM: model-x (10/20 tokens)',
          idempotency_key: null,
          metadata: { from_daily: 0, from_monthly: 0, from_extra: 0.25, ledger_type: 'llm_debit' },
        }),
      ]);
    });

    test('the router credit check reports balance and a missing account', async () => {
      const id = newAccount({ expiring: 0.005 });
      expect(await router.checkCredits(id)).toEqual({
        hasCredits: false,
        balance: 0.005,
        message: 'Insufficient credits. Balance: $0.0050',
      });
      expect(await router.checkCredits(newAccount({ nonExpiring: 3 }))).toEqual({
        hasCredits: true,
        balance: 3,
        message: 'OK',
      });
      expect(await router.checkCredits(unknownAccount())).toEqual({
        hasCredits: false,
        balance: 0,
        message: 'No credit account found',
      });
    });
  });

  describe('settle', () => {
    test('records consumed work within the balance', async () => {
      const id = newAccount({ expiring: 5 });
      const result = await settlement.settleCredits(id, 2, 'Sandbox compute', 'compute_debit', 'compute:w1');
      expect(ledger(id)).toEqual([
        {
          type: 'usage',
          amount: -2,
          balance_after: 3,
          description: 'Sandbox compute',
          is_expiring: true,
          expires_at: null,
          stripe_event_id: null,
          idempotency_key: 'compute:w1',
          processing_source: null,
          metadata: { from_daily: 0, from_monthly: 2, from_extra: 0, ledger_type: 'compute_debit', overdraft: false },
        },
      ]);
      expect(result).toMatchObject({ success: true, cost: 2, newBalance: 3, overdraft: false });
    });

    test('records work beyond the balance as an overdraft in the non-expiring bucket', async () => {
      const id = newAccount({ daily: 1, expiring: 1 });
      const result = await settlement.settleCredits(id, 5, 'Sandbox compute', 'compute_debit', 'compute:w2');
      expect(result).toMatchObject({ success: true, newBalance: -3, overdraft: true });
      expect(ledger(id)[0]).toMatchObject({
        amount: -5,
        balance_after: -3,
        metadata: { from_daily: 1, from_monthly: 1, from_extra: 3, ledger_type: 'compute_debit', overdraft: true },
      });
      expect(account(id)).toMatchObject({ balance: -3, daily: 0, expiring: 0, non_expiring: -3 });
    });

    test('a replayed settlement key charges once', async () => {
      const id = newAccount({ nonExpiring: 10 });
      const first = await settlement.settleCredits(id, 1, 'Sandbox compute', 'compute_debit', 'compute:w3');
      const second = await settlement.settleCredits(id, 1, 'Sandbox compute', 'compute_debit', 'compute:w3');
      expect(second.transactionId).toBe(first.transactionId);
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 9 });
    });

    test('refuses a settlement for an account without a credit row', async () => {
      const missing = unknownAccount();
      await expect(settlement.settleCredits(missing, 1, 'x', 'compute_debit')).rejects.toThrow(
        `Credit settlement refused for ${missing}: No credit account found`,
      );
    });

    test('an LLM settlement stamps its audit fields onto the ledger row', async () => {
      const id = newAccount({ nonExpiring: 1 });
      const usageEventId = psql('select gen_random_uuid()');
      const actorUserId = psql('select gen_random_uuid()');
      await credits.deductForLlmUsage({
        accountId: id,
        costUsd: 0.2,
        model: 'model-x',
        provider: 'kortix',
        actorUserId,
        usageEventId,
        upstreamCostUsd: 0.1,
        markup: 2,
      });
      expect(ledger(id)).toEqual([
        expect.objectContaining({
          type: 'usage',
          amount: -0.2,
          description: 'LLM · kortix/model-x',
          idempotency_key: `llm:${usageEventId}`,
          metadata: {
            from_daily: 0,
            from_monthly: 0,
            from_extra: 0.2,
            ledger_type: 'llm_debit',
            overdraft: false,
            usageEventId,
            upstreamCostUsd: 0.1,
            markup: 2,
            actorUserId,
            route: '/v1/llm/chat/completions',
          },
        }),
      ]);
    });
  });

  describe('reset', () => {
    test('replaces the expiring bucket and keeps non-expiring credit up to the balance', async () => {
      const id = newAccount({ daily: 1, expiring: 3, nonExpiring: 4 });
      await credits.resetExpiringCredits(id, 50, 'Monthly renewal', 'in_1');
      const [row] = ledger(id);
      expect(row).toMatchObject({
        type: 'tier_grant',
        amount: 50,
        balance_after: 54,
        description: 'Monthly renewal',
        is_expiring: true,
        stripe_event_id: 'in_1',
        idempotency_key: null,
        processing_source: 'atomic_function',
        metadata: { renewal: true, non_expiring_preserved: 4, previous_balance: 8 },
      });
      expect(row!.expires_at).not.toBeNull();
      expect(account(id)).toMatchObject({ balance: 54, expiring: 50, non_expiring: 4, daily: 1 });
    });

    test('a replayed reset key is a silent no-op', async () => {
      const id = newAccount({ expiring: 1 });
      await credits.resetExpiringCredits(id, 20, 'Monthly renewal', 'in_2');
      await credits.resetExpiringCredits(id, 20, 'Monthly renewal', 'in_2');
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 20, expiring: 20 });
    });

    test('a reset for an account without a credit row writes nothing and does not throw', async () => {
      const id = unknownAccount();
      await credits.resetExpiringCredits(id, 20, 'Monthly renewal', 'in_3');
      expect(ledger(id)).toEqual([]);
      expect(account(id)).toBeNull();
    });
  });

  describe('forfeit', () => {
    async function forfeit(accountId: string) {
      const current = await creditAccounts.getCreditAccount(accountId);
      const balance = current ? Number(current.balance) : 0;
      if (balance > 0) {
        await transactions.insertLedgerEntry({
          accountId,
          amount: String(-balance),
          balanceAfter: '0',
          type: 'forfeiture',
          description: 'Account deletion: credit balance forfeited',
          isExpiring: false,
        });
      }
      await creditAccounts.updateCreditAccount(accountId, {
        balance: '0',
        expiringCredits: '0',
        nonExpiringCredits: '0',
        dailyCreditsBalance: '0',
      } as never);
    }

    test('records the remaining balance as forfeited and empties every bucket', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 4 });
      await forfeit(id);
      expect(ledger(id)).toEqual([
        {
          type: 'forfeiture',
          amount: -7,
          balance_after: 0,
          description: 'Account deletion: credit balance forfeited',
          is_expiring: false,
          expires_at: null,
          stripe_event_id: null,
          idempotency_key: null,
          processing_source: null,
          metadata: {},
        },
      ]);
      expect(account(id)).toMatchObject({ balance: 0, daily: 0, expiring: 0, non_expiring: 0 });
    });

    test('an empty wallet forfeits nothing', async () => {
      const id = newAccount();
      await forfeit(id);
      expect(ledger(id)).toEqual([]);
    });
  });

  describe('balance', () => {
    test('reads every bucket, and zeros for an account without a credit row', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 3 });
      expect(await credits.getBalance(id)).toEqual({ balance: 6, expiring: 2, nonExpiring: 3, daily: 1 });
      expect(await credits.getBalance(unknownAccount())).toEqual({ balance: 0, expiring: 0, nonExpiring: 0, daily: 0 });
    });
  });
});
