/**
 * Credit codes: a code a person types to add credits to an account's wallet,
 * e.g. `FRONTIER` worth $100.
 *
 * Staff create a code in the admin console (amount, optional limit on the
 * number of accounts, optional expiry). An owner or admin of an account
 * redeems it once for that account (`POST /v1/billing/redeem-code`). The
 * credits land in the non-expiring bucket as a `promotional` ledger row, so
 * they behave like a top-up: they never expire and pay for compute on every
 * plan. They do not unlock managed models on Free (the plan alone decides
 * features).
 *
 * ── Exactly once ─────────────────────────────────────────────────────────────
 *
 * One transaction locks the code row, checks it, records the redemption row
 * (unique per code and account) and counts it. The wallet grant runs after the
 * commit under the key `credit-code:<code_id>:<account_id>`. When the grant
 * fails after the commit, the redemption row stays, and the next attempt runs
 * the same keyed grant again: the wallet applies it once, so a retry heals a
 * lost grant and never pays twice.
 */
import { creditCodeRedemptions, creditCodes } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { BillingError } from '../../errors';
import { db } from '../../shared/db';
import { wallet, type WalletBalance } from '../wallet';

export const CREDIT_CODE_PATTERN = /^[A-Z0-9_-]{3,64}$/;

export type CreditCodeErrorCode =
  | 'credit_code_invalid'
  | 'credit_code_expired'
  | 'credit_code_exhausted'
  | 'credit_code_already_redeemed'
  | 'credit_code_exists';

export class CreditCodeError extends BillingError {
  constructor(
    public readonly code: CreditCodeErrorCode,
    message: string,
    statusCode: number,
  ) {
    super(message, statusCode);
    this.name = 'CreditCodeError';
  }
}

const invalid = () => new CreditCodeError('credit_code_invalid', 'This code is not valid.', 404);

/** `  frontier ` → `FRONTIER`. Null when the result cannot be a code. */
export function normalizeCreditCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CREDIT_CODE_PATTERN.test(code) ? code : null;
}

export interface RedeemResult {
  code: string;
  amountUsd: number;
  balance: WalletBalance | null;
}

export async function redeemCreditCode(input: {
  accountId: string;
  userId: string | null;
  code: unknown;
  now?: Date;
}): Promise<RedeemResult> {
  const code = normalizeCreditCode(input.code);
  if (!code) throw invalid();
  const now = input.now ?? new Date();

  const claim = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(creditCodes)
      .where(eq(creditCodes.code, code))
      .for('update');
    if (!row || !row.active) throw invalid();

    const [existing] = await tx
      .select({ redemptionId: creditCodeRedemptions.redemptionId, amountUsd: creditCodeRedemptions.amountUsd })
      .from(creditCodeRedemptions)
      .where(and(eq(creditCodeRedemptions.codeId, row.codeId), eq(creditCodeRedemptions.accountId, input.accountId)));
    if (existing) return { codeId: row.codeId, amountUsd: Number(existing.amountUsd), existing: true };

    if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) {
      throw new CreditCodeError('credit_code_expired', 'This code has expired.', 410);
    }
    if (row.maxRedemptions !== null && row.redemptionCount >= row.maxRedemptions) {
      throw new CreditCodeError('credit_code_exhausted', 'This code has been fully redeemed.', 409);
    }

    await tx.insert(creditCodeRedemptions).values({
      codeId: row.codeId,
      accountId: input.accountId,
      redeemedBy: input.userId,
      amountUsd: row.amountUsd,
    });
    await tx
      .update(creditCodes)
      .set({ redemptionCount: sql`${creditCodes.redemptionCount} + 1` })
      .where(eq(creditCodes.codeId, row.codeId));
    return { codeId: row.codeId, amountUsd: Number(row.amountUsd), existing: false };
  });

  const grant = await wallet.grant({
    accountId: input.accountId,
    amount: claim.amountUsd,
    kind: 'promotional',
    description: `Credit code ${code}`,
    expiring: false,
    key: { request: `credit-code:${claim.codeId}:${input.accountId}` },
  });
  // A redemption row whose grant had already landed: a second redemption.
  if (claim.existing && grant.replayed) {
    throw new CreditCodeError(
      'credit_code_already_redeemed',
      'This account has already redeemed this code.',
      409,
    );
  }

  return { code, amountUsd: claim.amountUsd, balance: await wallet.balance(input.accountId) };
}

// ── Staff: create, list, switch off ─────────────────────────────────────────

export interface CreditCodeView {
  code_id: string;
  code: string;
  amount_usd: number;
  max_redemptions: number | null;
  redemption_count: number;
  expires_at: string | null;
  active: boolean;
  description: string | null;
  created_at: string;
}

function view(row: typeof creditCodes.$inferSelect): CreditCodeView {
  return {
    code_id: row.codeId,
    code: row.code,
    amount_usd: Number(row.amountUsd),
    max_redemptions: row.maxRedemptions,
    redemption_count: row.redemptionCount,
    expires_at: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    active: row.active,
    description: row.description,
    created_at: new Date(row.createdAt).toISOString(),
  };
}

export async function createCreditCode(input: {
  code: unknown;
  amountUsd: number;
  maxRedemptions?: number | null;
  expiresAt?: string | null;
  description?: string | null;
  createdBy: string | null;
}): Promise<CreditCodeView> {
  const code = normalizeCreditCode(input.code);
  if (!code) {
    throw new CreditCodeError('credit_code_invalid', 'A code is 3 to 64 letters, digits, "-" or "_".', 400);
  }
  const [row] = await db
    .insert(creditCodes)
    .values({
      code,
      amountUsd: input.amountUsd.toFixed(2),
      maxRedemptions: input.maxRedemptions ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      description: input.description?.trim() || null,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: creditCodes.code })
    .returning();
  if (!row) throw new CreditCodeError('credit_code_exists', `The code ${code} already exists.`, 409);
  return view(row);
}

export async function listCreditCodes(): Promise<CreditCodeView[]> {
  const rows = await db.select().from(creditCodes).orderBy(desc(creditCodes.createdAt));
  return rows.map(view);
}

export async function setCreditCodeActive(codeId: string, active: boolean): Promise<CreditCodeView | null> {
  const [row] = await db.update(creditCodes).set({ active }).where(eq(creditCodes.codeId, codeId)).returning();
  return row ? view(row) : null;
}
