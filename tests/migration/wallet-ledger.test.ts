// The wallet (apps/api/src/billing/wallet) against a real, fully migrated
// PostgreSQL: the exact `credit_ledger` row and `credit_accounts` buckets each
// operation leaves behind, its replay behaviour, and its refusal behaviour.
//
// These expectations were first recorded against the code the wallet replaced
// (the PostgREST `atomic_*` callers in billing/services/credits.ts and
// settle-credits.ts), and the wallet reproduces them. One is deliberately
// stronger: a request-keyed grant now applies once for the life of the ledger,
// not once per hour.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { contextualDatabase } from '../../apps/api/src/shared/db-context';
import { createDb } from '../../packages/db/src/client';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-wallet-ledger-test';
// Below 32768 for the reason given in credit-rpc-overloads.test.ts.
const PORT = Number(process.env.WALLET_LEDGER_TEST_PORT || 5446);
const ROOT = repoRoot();
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
  let wallet: typeof import('../../apps/api/src/billing/wallet').wallet;
  let database: ReturnType<typeof createDb> | undefined;
  let router: typeof import('../../apps/api/src/router/services/billing');
  let errors: typeof import('../../apps/api/src/errors');
  let honesty: typeof import('../../apps/api/src/billing/ledger-type-honesty');

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
    // `mock.module` is process-global. The `db-suites` lane runs each file in
    // its own process, but a hand-run `bun test tests/migration` runs every
    // file in one process, in directory order, and another file here replaces
    // `shared/db` with a client for ITS container. Bind the module to this
    // container explicitly, with the same exports the real module has, so file
    // order cannot decide which database the wallet writes to.
    database = createDb(url);
    const scoped = contextualDatabase(database);
    mock.module('../../apps/api/src/shared/db', () => ({
      hasDatabase: true,
      db: scoped.db,
      withDbTransaction: scoped.transaction,
      afterDbCommit: scoped.afterCommit,
    }));
    ({ wallet } = await import('../../apps/api/src/billing/wallet'));
    router = await import('../../apps/api/src/router/services/billing');
    errors = await import('../../apps/api/src/errors');
    honesty = await import('../../apps/api/src/billing/ledger-type-honesty');
  }, 300_000);

  afterAll(async () => {
    await database?.$client.end({ timeout: 5 });
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  describe('grant', () => {
    test('an expiring grant keyed by an external event lands in the expiring bucket and records the key twice', async () => {
      const id = newAccount({ expiring: 10, nonExpiring: 5 });
      await wallet.grant({
        accountId: id,
        amount: 50,
        kind: 'tier_grant',
        description: 'Plan activated',
        expiring: true,
        key: { event: 'subscription_activation:sub_1' },
      });
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
      const purchase = {
        accountId: id,
        amount: 20,
        kind: 'purchase',
        description: 'Credit purchase',
        expiring: false,
        key: { event: 'cs_replay' },
      };
      expect(await wallet.grant(purchase)).toMatchObject({ replayed: false });
      expect(await wallet.grant(purchase)).toEqual({ replayed: true, ledgerId: null });
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 20, non_expiring: 20 });
    });

    test('concurrent grants under one event key apply once', async () => {
      const id = newAccount();
      await Promise.all(
        Array.from({ length: 4 }, () =>
          wallet.grant({
            accountId: id,
            amount: 7,
            kind: 'purchase',
            description: 'Auto-topup',
            expiring: false,
            key: { event: 'pi_concurrent' },
          }),
        ),
      );
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 7, non_expiring: 7 });
    });

    test('an unkeyed grant applies every time it is called', async () => {
      const id = newAccount();
      const goodwill = {
        accountId: id,
        amount: 3,
        kind: 'admin_grant',
        description: 'Goodwill (by admin x)',
        expiring: false,
        key: null,
      };
      await wallet.grant(goodwill);
      await wallet.grant(goodwill);
      const rows = ledger(id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ type: 'admin_grant', amount: 3, is_expiring: false, stripe_event_id: null, idempotency_key: null });
      expect(account(id)).toMatchObject({ balance: 6, non_expiring: 6 });
    });

    test('a negative operator correction reduces the non-expiring bucket', async () => {
      const id = newAccount({ expiring: 4, nonExpiring: 10 });
      await wallet.grant({
        accountId: id,
        amount: -6,
        kind: 'admin_debit',
        description: 'Correction (by admin x)',
        expiring: false,
        key: null,
      });
      expect(ledger(id)).toEqual([
        expect.objectContaining({ type: 'admin_debit', amount: -6, balance_after: 8, is_expiring: false }),
      ]);
      expect(account(id)).toMatchObject({ balance: 8, expiring: 4, non_expiring: 4 });
    });

    test('a grant carries its expiry stamp', async () => {
      const id = newAccount();
      await wallet.grant({
        accountId: id,
        amount: 25,
        kind: 'trial_grant',
        description: 'Trial grant',
        expiring: true,
        expiresAt: '2030-01-31T00:00:00.000Z',
        key: null,
      });
      const [row] = ledger(id);
      expect(new Date(row!.expires_at!).toISOString()).toBe('2030-01-31T00:00:00.000Z');
      expect(row).toMatchObject({ type: 'trial_grant', is_expiring: true, stripe_event_id: null, idempotency_key: null });
    });

    test('a grant keyed by an internal request records the key once, without an event id', async () => {
      const id = newAccount();
      const refund = {
        accountId: id,
        amount: 0.004,
        kind: 'llm_reservation_refund',
        description: 'LLM hold refund',
        expiring: false,
        key: { request: 'llm-hold-refund:req_1' },
      };
      await wallet.grant(refund);
      expect(await wallet.grant(refund)).toEqual({ replayed: true, ledgerId: null });
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

    // The one deliberate change. `atomic_add_credits` looks back only one hour
    // for a request key; before the wallet, the trial sweep compensated with
    // its own ledger read and the gateway hold refund did not.
    test('a request-keyed grant replayed after an hour still applies once', async () => {
      const id = newAccount();
      const grant = () =>
        wallet.grant({
          accountId: id,
          amount: 25,
          kind: 'trial_grant',
          description: 'Trial monthly re-grant',
          expiring: true,
          key: { request: `trial_regrant_${id}_1` },
        });
      await grant();
      psql(`update kortix.credit_ledger set created_at = now() - interval '2 hours' where account_id = '${id}'`);
      expect(await grant()).toEqual({ replayed: true, ledgerId: null });
      expect(ledger(id)).toHaveLength(1);
    });

    test('a grant to an account without a credit row creates the row', async () => {
      const id = unknownAccount();
      await wallet.grant({
        accountId: id,
        amount: 2,
        kind: 'free_tier_grant',
        description: 'Free tier welcome credits',
        expiring: true,
        key: { event: `free_tier_signup:${id}` },
      });
      expect(account(id)).toEqual({ balance: 2, expiring: 2, non_expiring: 0, daily: 0, tier: 'none' });
      expect(ledger(id)).toHaveLength(1);
    });
  });

  describe('debit (admission)', () => {
    test('drains daily, then expiring, then non-expiring, and labels the row usage', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 3 });
      const result = await wallet.debit({
        accountId: id,
        amount: 2.5,
        description: 'LLM gateway admission hold',
        kind: 'llm_debit',
        key: null,
      });
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
      expect(result).toMatchObject({ amount: 2.5, balance: 3.5, replayed: false });
      expect(typeof result.transactionId).toBe('string');
    });

    test('refuses a debit the balance cannot cover and writes nothing', async () => {
      const id = newAccount({ nonExpiring: 1 });
      const error = await wallet
        .debit({ accountId: id, amount: 5, description: 'Agent run usage', kind: 'usage', key: null })
        .catch((err) => err);
      expect(error).toBeInstanceOf(errors.InsufficientCreditsError);
      expect(error.message).toBe('Insufficient credits. Balance: $1.0000, required: $5.0000');
      expect(error.reason).toBe('Insufficient credits');
      expect(ledger(id)).toEqual([]);
      expect(account(id)).toMatchObject({ balance: 1, non_expiring: 1 });
    });

    test('repeated debits drain the wallet to exactly zero and then refuse', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 3 });
      const kinds = ['usage', 'llm_debit', 'compute_debit', 'token_deduction', 'token_overage', 'usage'] as const;
      const outcomes: string[] = [];
      for (const kind of kinds) {
        outcomes.push(
          await wallet
            .debit({ accountId: id, amount: 1.5, description: `Tick ${kind}`, kind, key: null })
            .then(() => 'ok', (err) => err.constructor.name),
        );
      }
      expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'InsufficientCreditsError', 'InsufficientCreditsError']);
      expect(account(id)).toMatchObject({ balance: 0, daily: 0, expiring: 0, non_expiring: 0 });
      expect(ledger(id).map((row) => [row.type, row.metadata.ledger_type])).toEqual([
        ['usage', 'usage'],
        ['usage', 'llm_debit'],
        ['usage', 'compute_debit'],
        ['usage', 'token_deduction'],
      ]);
    });

    test('refuses a debit for an account without a credit row', async () => {
      const error = await wallet
        .debit({ accountId: unknownAccount(), amount: 1, description: 'Agent run usage', kind: 'usage', key: null })
        .catch((err) => err);
      expect(error).toBeInstanceOf(errors.InsufficientCreditsError);
      expect(error.reason).toBe('No credit account found');
    });

    test('a keyed debit replays instead of charging twice', async () => {
      const id = newAccount({ nonExpiring: 10 });
      const metered = { accountId: id, amount: 4, description: 'Metered', kind: 'usage' as const, key: { request: 'debit:1' } };
      const first = await wallet.debit(metered);
      const second = await wallet.debit(metered);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.replayed).toBe(true);
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 6 });
    });

    test('rejects a non-usage ledger kind before any write', async () => {
      const id = newAccount({ nonExpiring: 10 });
      const write = { accountId: id, amount: 1, description: 'x', kind: 'admin_debit' as never, key: null };
      await expect(wallet.debit(write)).rejects.toBeInstanceOf(honesty.LedgerTypeMismatchError);
      await expect(wallet.settle(write)).rejects.toBeInstanceOf(honesty.LedgerTypeMismatchError);
      expect(ledger(id)).toEqual([]);
      expect(account(id)).toMatchObject({ balance: 10, non_expiring: 10 });
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
      const result = await wallet.settle({
        accountId: id,
        amount: 2,
        description: 'Sandbox compute',
        kind: 'compute_debit',
        key: { request: 'compute:w1' },
      });
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
      expect(result).toMatchObject({ amount: 2, balance: 3, overdraft: false, replayed: false });
    });

    test('records work beyond the balance as an overdraft in the non-expiring bucket', async () => {
      const id = newAccount({ daily: 1, expiring: 1 });
      const result = await wallet.settle({
        accountId: id,
        amount: 5,
        description: 'Sandbox compute',
        kind: 'compute_debit',
        key: { request: 'compute:w2' },
      });
      expect(result).toMatchObject({ balance: -3, overdraft: true });
      expect(ledger(id)[0]).toMatchObject({
        amount: -5,
        balance_after: -3,
        metadata: { from_daily: 1, from_monthly: 1, from_extra: 3, ledger_type: 'compute_debit', overdraft: true },
      });
      expect(account(id)).toMatchObject({ balance: -3, daily: 0, expiring: 0, non_expiring: -3 });
    });

    test('a replayed settlement key charges once', async () => {
      const id = newAccount({ nonExpiring: 10 });
      const window = {
        accountId: id,
        amount: 1,
        description: 'Sandbox compute',
        kind: 'compute_debit' as const,
        key: { request: 'compute:w3' },
      };
      const first = await wallet.settle(window);
      const second = await wallet.settle(window);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.replayed).toBe(true);
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 9 });
    });

    test('refuses a settlement for an account without a credit row', async () => {
      const missing = unknownAccount();
      await expect(
        wallet.settle({ accountId: missing, amount: 1, description: 'x', kind: 'compute_debit', key: null }),
      ).rejects.toThrow(
        `Credit settlement refused for ${missing}: No credit account found`,
      );
    });

    test('a settlement stamps its audit fields onto the ledger row', async () => {
      const id = newAccount({ nonExpiring: 1 });
      const usageEventId = psql('select gen_random_uuid()');
      const actorUserId = psql('select gen_random_uuid()');
      await wallet.settle({
        accountId: id,
        amount: 0.2,
        description: 'LLM · kortix/model-x',
        kind: 'llm_debit',
        key: { request: `llm:${usageEventId}` },
        audit: { usageEventId, upstreamCostUsd: 0.1, markup: 2, actorUserId, route: '/v1/llm/chat/completions' },
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
      await wallet.reset({ accountId: id, amount: 50, description: 'Monthly renewal', key: { event: 'in_1' } });
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
      const renewal = { accountId: id, amount: 20, description: 'Monthly renewal', key: { event: 'in_2' } };
      await wallet.reset(renewal);
      await wallet.reset(renewal);
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 20, expiring: 20 });
    });

    // A renewal webhook and a grant can name one Stripe event. The grant's
    // event pre-check sees the reset's row, so the period is paid once.
    test('a grant after a reset under one event key writes nothing', async () => {
      const id = newAccount();
      await wallet.reset({ accountId: id, amount: 20, description: 'Monthly renewal', key: { event: 'in_4' } });
      expect(
        await wallet.grant({
          accountId: id,
          amount: 20,
          kind: 'tier_grant',
          description: 'Monthly renewal',
          expiring: true,
          key: { event: 'in_4' },
        }),
      ).toEqual({ replayed: true, ledgerId: null });
      expect(ledger(id)).toHaveLength(1);
      expect(account(id)).toMatchObject({ balance: 20, expiring: 20 });
    });

    test('a reset for an account without a credit row writes nothing and does not throw', async () => {
      const id = unknownAccount();
      await wallet.reset({ accountId: id, amount: 20, description: 'Monthly renewal', key: { event: 'in_3' } });
      expect(ledger(id)).toEqual([]);
      expect(account(id)).toBeNull();
    });
  });

  describe('forfeit', () => {
    test('records the remaining balance as forfeited and empties every bucket', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 4 });
      await wallet.forfeit(id);
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
      await wallet.forfeit(id);
      expect(ledger(id)).toEqual([]);
    });
  });

  describe('balance', () => {
    test('reads every bucket, and null for an account without a credit row', async () => {
      const id = newAccount({ daily: 1, expiring: 2, nonExpiring: 3 });
      expect(await wallet.balance(id)).toEqual({ balance: 6, expiring: 2, nonExpiring: 3, daily: 1 });
      expect(await wallet.balance(unknownAccount())).toBeNull();
    });
  });
});
