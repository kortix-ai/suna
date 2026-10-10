/**
 * The daily model-spend cap of Capture (pipelines and Ask), per account per UTC
 * day, and the one place that records spend. The cap is checked before a model
 * call; spend is added after it with the gateway's reported cost.
 */
import { captureAiUsage } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';

const today = () => new Date().toISOString().slice(0, 10);

export async function spentToday(accountId: string): Promise<number> {
  const [row] = await db
    .select({ cost: captureAiUsage.costUsd })
    .from(captureAiUsage)
    .where(and(eq(captureAiUsage.accountId, accountId), eq(captureAiUsage.day, today())))
    .limit(1);
  return Number(row?.cost ?? 0);
}

/** True while the account may spend more today. */
export async function withinBudget(accountId: string): Promise<boolean> {
  const cap = config.KORTIX_CAPTURE_DAILY_COST_CAP_USD;
  return !cap || (await spentToday(accountId)) < cap;
}

export class CaptureBudgetExceeded extends Error {
  constructor() {
    super('The Capture model budget for today is spent; work resumes tomorrow (KORTIX_CAPTURE_DAILY_COST_CAP_USD)');
  }
}

export async function recordSpend(accountId: string, costUsd: number, requests: number): Promise<void> {
  if (!costUsd && !requests) return;
  await db
    .insert(captureAiUsage)
    .values({ accountId, day: today(), costUsd: String(costUsd), requests })
    .onConflictDoUpdate({
      target: [captureAiUsage.accountId, captureAiUsage.day],
      set: { costUsd: sql`${captureAiUsage.costUsd} + ${String(costUsd)}::numeric`, requests: sql`${captureAiUsage.requests} + ${requests}` },
    });
}
