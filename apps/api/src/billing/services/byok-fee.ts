/**
 * The platform fee on bring-your-own-key model usage
 * (.agents/skills/billing/references/plans-and-access.md, "Bring your own key").
 *
 * OpenRouter's model at a lower allowance: the first BYOK_FEE_FREE_MONTHLY_USD
 * of list-price BYOK usage in a calendar month (UTC) is free; past it, each
 * request pays BYOK_FEE_PERCENT of its list price from the wallet.
 *
 * Settled AFTER the request, never at admission: a BYOK request stays
 * `billingMode: 'none'`, so a drained wallet never blocks a customer's own key
 * and no Kortix-billed fallback is ever added (learnings 2026-09-22, "Resolve
 * the LLM payee before touching the Kortix wallet"). Only the fee is a Kortix
 * charge; the provider's own bill stays in gateway observability.
 */
import { gatewayRequestLogs } from '@kortix/db';
import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export const BYOK_FEE_FREE_MONTHLY_USD = 1000;
export const BYOK_FEE_PERCENT = 5;

/** Subscriptions, not metered keys: ChatGPT and OpenCode Go are never charged. */
const FEE_EXEMPT_PROVIDERS = ['openai-codex', 'opencode-go'];

export function byokFeeUsd(input: {
  provider: string | null | undefined;
  upstreamCostUsd: number | null | undefined;
  monthToDateUsd: number;
  enterpriseContract: boolean;
}): number {
  const cost = input.upstreamCostUsd ?? 0;
  if (cost <= 0 || input.enterpriseContract) return 0;
  if (FEE_EXEMPT_PROVIDERS.includes(input.provider ?? '')) return 0;
  if (input.monthToDateUsd < BYOK_FEE_FREE_MONTHLY_USD) return 0;
  return Math.round(cost * BYOK_FEE_PERCENT * 10_000) / 1_000_000;
}

const MONTH_TO_DATE_TTL_MS = 60_000;

// replica-local: a 60 s cache of each account's month-to-date BYOK list spend.
// A replica that reads a slightly stale sum moves the start of the fee by at
// most a minute of requests; the sum itself lives in gateway_request_logs.
const monthToDate = new Map<string, { usd: number; month: string; expiresAt: number }>();

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** List-price BYOK usage of the account this calendar month (UTC), fee-exempt providers excluded. */
export async function byokMonthToDateUsd(accountId: string, now: Date = new Date()): Promise<number> {
  const start = monthStart(now);
  const month = start.toISOString().slice(0, 7);
  const hit = monthToDate.get(accountId);
  if (hit && hit.month === month && hit.expiresAt > now.getTime()) return hit.usd;
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${gatewayRequestLogs.upstreamCost}), 0)` })
    .from(gatewayRequestLogs)
    .where(
      and(
        eq(gatewayRequestLogs.accountId, accountId),
        gte(gatewayRequestLogs.createdAt, start),
        eq(gatewayRequestLogs.billingMode, 'none'),
        notInArray(gatewayRequestLogs.provider, FEE_EXEMPT_PROVIDERS),
      ),
    );
  const usd = Number(row?.usd ?? 0) || 0;
  monthToDate.set(accountId, { usd, month, expiresAt: now.getTime() + MONTH_TO_DATE_TTL_MS });
  return usd;
}

/** Count a settled BYOK request into the cached sum, so the allowance is crossed on time. */
export function noteByokUsage(accountId: string, provider: string | null | undefined, upstreamCostUsd: number): void {
  if (FEE_EXEMPT_PROVIDERS.includes(provider ?? '')) return;
  const hit = monthToDate.get(accountId);
  if (hit) hit.usd += upstreamCostUsd;
}

/** Test seam: forget every cached sum. */
export function clearByokMonthToDateCache(): void {
  monthToDate.clear();
}
