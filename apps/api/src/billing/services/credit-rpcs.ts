/**
 * Thin Drizzle wrappers around the three Postgres credit functions.
 *
 * These exist so credits.ts doesn't sprinkle raw SQL templates around its
 * business logic, AND so unit tests can mock just this module without
 * intercepting `db.execute` globally (which would clash with all the other
 * code that uses Drizzle).
 *
 * The underlying functions are defined in packages/db/migrations/
 *   - 20240101000002_fn_atomic_use_credits.sql
 *   - 20240101000003_fn_atomic_add_credits.sql
 *   - 20240101000004_fn_atomic_reset_expiring_credits.sql
 *   - 20240101000133_atomic_use_credits_ledger_type.sql  (adds p_ledger_type)
 *
 * All three return JSONB.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export interface AtomicUseCreditsResult {
  success: boolean;
  error?: string;
  amount_deducted?: number;
  new_total?: number;
  transaction_id?: string;
}

export async function callAtomicUseCredits(params: {
  accountId: string;
  amount: number;
  description: string;
  ledgerType: string;
}): Promise<AtomicUseCreditsResult | null> {
  const rows = await db.execute<{ data: AtomicUseCreditsResult }>(sql`
    SELECT atomic_use_credits(
      ${params.accountId}::uuid,
      ${params.amount}::numeric,
      ${params.description}::text,
      ${params.ledgerType}::text
    ) AS data
  `);
  return (rows[0]?.data ?? null) as AtomicUseCreditsResult | null;
}

export async function callAtomicAddCredits(params: {
  accountId: string;
  amount: number;
  isExpiring: boolean;
  description: string;
  expiresAt: string | null;
  type: string;
  stripeEventId: string | null;
  idempotencyKey: string | null;
}): Promise<unknown> {
  const rows = await db.execute<{ data: unknown }>(sql`
    SELECT atomic_add_credits(
      ${params.accountId}::uuid,
      ${params.amount}::numeric,
      ${params.isExpiring}::boolean,
      ${params.description}::text,
      ${params.expiresAt}::timestamptz,
      ${params.type}::text,
      ${params.stripeEventId}::text,
      ${params.idempotencyKey}::text
    ) AS data
  `);
  return rows[0]?.data ?? null;
}

export async function callAtomicResetExpiringCredits(params: {
  accountId: string;
  description: string;
  newCredits: number;
  stripeEventId: string | null;
}): Promise<void> {
  await db.execute(sql`
    SELECT atomic_reset_expiring_credits(
      ${params.accountId}::uuid,
      ${params.description}::text,
      ${params.newCredits}::numeric,
      ${params.stripeEventId}::text
    )
  `);
}
