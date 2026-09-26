/**
 * THE WALLET — the only module that moves credit.
 *
 * Every write to `kortix.credit_accounts` balances and `kortix.credit_ledger`
 * goes through `wallet`. Callers never build ledger rows, never call the SQL
 * functions, and never read the RPC result shapes.
 *
 *   grant   — add credit (a purchase, a plan grant, a refund, an operator
 *             correction; an operator correction may be negative).
 *   debit   — ADMISSION: "may this account start work?" Refuses anything the
 *             balance cannot cover and throws `InsufficientCreditsError`.
 *   settle  — SETTLEMENT: "record work already done." Always records, and may
 *             take the balance below zero (the overdraft lands in the
 *             non-expiring bucket, and the next `debit` refuses).
 *   reset   — start a new period: replace the expiring bucket.
 *   forfeit — account deletion: record the remaining balance as forfeited and
 *             empty every bucket.
 *   balance — read the buckets.
 *
 * ── The idempotency contract ─────────────────────────────────────────────────
 *
 * Every write takes a `key` naming the thing being paid for (an invoice, a
 * subscription activation, a compute window, a gateway request). A keyed write
 * applies AT MOST ONCE: a replay — a retry after a lost response, a redelivered
 * webhook, a second replica running the same sweep — succeeds, reports
 * `replayed: true`, and moves no money. Derive the key from WHAT is billed,
 * never from the clock or a random id, so a retry produces the same key.
 * `key: null` states that the write is not idempotent: an operator action, a
 * reservation refund, an admission hold. The field is required, so that choice
 * is always visible at the call site.
 *
 * A key has one of two origins, and the origin fixes where the ledger records
 * it. Both origins give the same at-most-once guarantee.
 *
 *   { event: id }   — an id issued once from outside the request: a Stripe or
 *                     RevenueCat event, invoice, session or PaymentIntent, a
 *                     subscription activation, a billing period. Stored in
 *                     `stripe_event_id`, whose UNIQUE constraint enforces it.
 *                     Used by grant and reset.
 *   { request: id } — an id of one unit of our own work: a usage event, a
 *                     compute window, a gateway request, a trial month.
 *                     Stored in `idempotency_key`. Used by debit, settle, and
 *                     grant.
 *
 * The SQL functions check a key against the whole ledger before they write, and
 * a unique index on `credit_ledger.idempotency_key` refuses a second row that a
 * concurrent write under the same key slipped past that check.
 *
 * ── Storage ──────────────────────────────────────────────────────────────────
 *
 * The arithmetic lives in the SQL functions of the private `kortix_wallet`
 * schema (`grant_credits`, `debit_credits`, `reset_expiring_credits`), which
 * no client role can reach. The wallet calls them over the API's own
 * PostgreSQL connection with named arguments, so an overload added later can
 * never re-bind a call by arity. `debit` and `settle` are one function; the
 * balance floor is its `p_enforce_floor` argument.
 */
import { creditAccounts, creditLedger } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { InsufficientCreditsError } from '../../errors';
import { db } from '../../shared/db';
import { isDuplicateCreditGrantError } from './duplicate-error';
import { assertRpcDebitLedgerType } from '../ledger-type-honesty';

export type WalletKey = { readonly event: string } | { readonly request: string };

/** Sub-kinds of a debit, stamped into `metadata.ledger_type`; the row's `type` is always `usage`. */
export type LedgerDebitType = 'usage' | 'compute_debit' | 'llm_debit' | 'token_deduction' | 'token_overage';

interface WalletWrite {
  accountId: string;
  amount: number;
  description: string;
}

export interface GrantInput extends WalletWrite {
  /** `credit_ledger.type`: `tier_grant`, `purchase`, `admin_debit`, … */
  kind: string;
  /** true: the expiring bucket (reset each period); false: the non-expiring bucket. */
  expiring: boolean;
  /** Ledger expiry stamp for an expiring grant, e.g. a trial's end. */
  expiresAt?: string | null;
  key: WalletKey | null;
}

export interface DebitInput extends WalletWrite {
  kind: LedgerDebitType;
  key: { readonly request: string } | null;
}

export interface SettleInput extends DebitInput {
  /** Fields merged into the ledger row's metadata after it is written. */
  audit?: Record<string, unknown>;
}

export interface ResetInput extends WalletWrite {
  key: { readonly event: string };
}

export interface GrantResult {
  replayed: boolean;
  ledgerId: string | null;
}

export interface DebitResult {
  amount: number;
  balance: number;
  transactionId: string;
  replayed: boolean;
}

export interface SettleResult extends DebitResult {
  overdraft: boolean;
}

export interface WalletBalance {
  balance: number;
  expiring: number;
  nonExpiring: number;
  daily: number;
}

/** What the SQL functions return, as jsonb. */
interface RpcResult {
  success: boolean;
  error?: string;
  replayed?: boolean;
  duplicate_prevented?: boolean;
  ledger_id?: string;
  amount_deducted?: number;
  new_total?: number;
  overdraft?: boolean;
  transaction_id?: string;
}

async function callWalletFunction(query: ReturnType<typeof sql>): Promise<RpcResult> {
  const rows = await db.execute(sql`SELECT ${query} AS result`);
  const row = rows[0] as { result?: RpcResult } | undefined;
  if (!row?.result) throw new Error('wallet function returned no result');
  return row.result;
}

function eventId(key: WalletKey | null): string | null {
  return key && 'event' in key ? key.event : null;
}

function requestId(key: WalletKey | null): string | null {
  return key && 'request' in key ? key.request : null;
}

/** Fire-and-forget: a debit or settlement may have crossed the auto-topup threshold. */
async function triggerAutoTopup(accountId: string): Promise<void> {
  const { checkAndTriggerAutoTopup } = await import('../services/auto-topup');
  void checkAndTriggerAutoTopup(accountId);
}

async function grant(input: GrantInput): Promise<GrantResult> {
  const event = eventId(input.key);
  const request = requestId(input.key);
  // An event key is also recorded as the row's idempotency key, namespaced by
  // account — the shape every event-keyed grant row has always had.
  const idempotencyKey = event ? `grant:${input.accountId}:${event}` : request;

  try {
    const result = await callWalletFunction(sql`kortix_wallet.grant_credits(
      p_account_id => ${input.accountId}::uuid,
      p_amount => ${input.amount}::numeric,
      p_is_expiring => ${input.expiring}::boolean,
      p_description => ${input.description}::text,
      p_expires_at => ${input.expiresAt ?? null}::timestamptz,
      p_type => ${input.kind}::text,
      p_stripe_event_id => ${event}::text,
      p_idempotency_key => ${idempotencyKey}::text
    )`);
    return { replayed: result.duplicate_prevented === true, ledgerId: result.ledger_id ?? null };
  } catch (error) {
    // Two concurrent grants under one key: the loser's insert hits a UNIQUE
    // constraint. The grant landed once, which is the contract.
    if (isDuplicateCreditGrantError(error)) return { replayed: true, ledgerId: null };
    throw error;
  }
}

async function debit(input: DebitInput): Promise<DebitResult> {
  // The SQL function writes `type = 'usage'` on every debit row, so a
  // non-usage kind would manufacture a row that contradicts itself
  // (2026-07-30 mislabelled-clawback incident). Refuse before money moves.
  assertRpcDebitLedgerType(input.kind);

  let result: RpcResult;
  try {
    result = await callWalletFunction(sql`kortix_wallet.debit_credits(
      p_account_id => ${input.accountId}::uuid,
      p_amount => ${input.amount}::numeric,
      p_enforce_floor => true,
      p_description => ${input.description}::text,
      p_ledger_type => ${input.kind}::text,
      p_idempotency_key => ${requestId(input.key)}::text
    )`);
  } catch (error) {
    console.error('[Wallet] debit failed:', error);
    throw new InsufficientCreditsError(await currentBalance(input.accountId), input.amount, 'Deduction error');
  }

  if (!result.success) {
    throw new InsufficientCreditsError(
      await currentBalance(input.accountId),
      input.amount,
      result.error ?? 'Insufficient credits',
    );
  }

  await triggerAutoTopup(input.accountId);
  return {
    amount: result.amount_deducted ?? input.amount,
    balance: result.new_total ?? 0,
    transactionId: result.transaction_id as string,
    replayed: result.replayed === true,
  };
}

async function settle(input: SettleInput): Promise<SettleResult> {
  assertRpcDebitLedgerType(input.kind);

  let result: RpcResult;
  try {
    result = await callWalletFunction(sql`kortix_wallet.debit_credits(
      p_account_id => ${input.accountId}::uuid,
      p_amount => ${input.amount}::numeric,
      p_enforce_floor => false,
      p_description => ${input.description}::text,
      p_ledger_type => ${input.kind}::text,
      p_idempotency_key => ${requestId(input.key)}::text
    )`);
  } catch (error) {
    console.error('[Wallet] settlement failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Credit settlement failed for ${input.accountId}: ${message}`);
  }

  if (!result.success) {
    // Only a missing credit row or a non-positive amount: settlement has no
    // balance check.
    throw new Error(`Credit settlement refused for ${input.accountId}: ${result.error ?? 'unknown'}`);
  }

  if (result.overdraft) {
    // Alertable: the account consumed more than it held. Bounded by the
    // admission floor, but the population is worth watching.
    console.warn(
      `[Wallet] settlement overdraft account=${input.accountId} amount=${input.amount} balance=${result.new_total}`,
    );
  }

  if (input.audit && result.transaction_id) {
    await db
      .update(creditLedger)
      .set({
        metadata: sql`COALESCE(${creditLedger.metadata}, '{}'::jsonb) || ${JSON.stringify(input.audit)}::jsonb`,
      })
      .where(eq(creditLedger.id, result.transaction_id))
      .catch((error: unknown) => {
        console.warn('[Wallet] failed to stamp ledger audit metadata:', error);
      });
  }

  await triggerAutoTopup(input.accountId);
  return {
    amount: result.amount_deducted ?? input.amount,
    balance: result.new_total ?? 0,
    overdraft: result.overdraft ?? false,
    transactionId: result.transaction_id as string,
    replayed: result.replayed === true,
  };
}

async function reset(input: ResetInput): Promise<void> {
  try {
    // A missing credit row returns `success: false` and writes nothing; a
    // reset has nothing to renew there, so that is not an error.
    await callWalletFunction(sql`kortix_wallet.reset_expiring_credits(
      p_account_id => ${input.accountId}::uuid,
      p_new_credits => ${input.amount}::numeric,
      p_description => ${input.description}::text,
      p_stripe_event_id => ${input.key.event}::text
    )`);
  } catch (error) {
    // The same reset arriving twice is the key doing its job. Not a fault: no
    // error log (PROD 2026-09-04 → 09-08 logged 1,118 of these for one account).
    if (isDuplicateCreditGrantError(error)) {
      console.info('[Wallet] reset already applied', { accountId: input.accountId, key: input.key.event });
      return;
    }
    throw error;
  }
}

const FORFEITURE_DESCRIPTION = 'Account deletion: credit balance forfeited';

async function forfeit(accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ balance: creditAccounts.balance })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .for('update');
    const remaining = row ? Number(row.balance) : 0;
    if (remaining > 0) {
      await tx.insert(creditLedger).values({
        accountId,
        amount: String(-remaining),
        balanceAfter: '0',
        type: 'forfeiture',
        description: FORFEITURE_DESCRIPTION,
        isExpiring: false,
      });
    }
    await tx
      .update(creditAccounts)
      .set({ balance: '0', expiringCredits: '0', nonExpiringCredits: '0', dailyCreditsBalance: '0' })
      .where(eq(creditAccounts.accountId, accountId));
  });
}

/** The account's buckets, or null when it has no credit row. */
async function balance(accountId: string): Promise<WalletBalance | null> {
  const [row] = await db
    .select({
      balance: creditAccounts.balance,
      expiring: creditAccounts.expiringCredits,
      nonExpiring: creditAccounts.nonExpiringCredits,
      daily: creditAccounts.dailyCreditsBalance,
    })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);
  if (!row) return null;
  return {
    balance: Number(row.balance) || 0,
    expiring: Number(row.expiring) || 0,
    nonExpiring: Number(row.nonExpiring) || 0,
    daily: Number(row.daily) || 0,
  };
}

async function currentBalance(accountId: string): Promise<number> {
  return (await balance(accountId))?.balance ?? 0;
}

export const wallet = { grant, debit, settle, reset, forfeit, balance };
export type Wallet = typeof wallet;
