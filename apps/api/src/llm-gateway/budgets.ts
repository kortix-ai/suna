import { and, eq, gte, sql } from 'drizzle-orm';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { db } from '../shared/db';
import { totalSpendWhereSql } from '../shared/llm-spend';
import { formatUsdAsCredits } from '@kortix/shared';

export type Period = 'day' | 'week' | 'month';

/** A budget at or past 80% of its limit this period: who to tell (KRTX-1718). */
export interface BudgetCrossing {
  budgetId: string;
  /** The highest threshold reached; spend only grows within a period. */
  threshold: 80 | 100;
  scope: 'project' | 'member';
  subjectUserId: string | null;
  period: Period;
  action: 'block' | 'warn';
  limitUsd: number;
  spentUsd: number;
}

export interface BudgetCheckResult {
  /** A 'block' budget is exhausted — the caller must deny the request. */
  exceeded: boolean;
  /** Human-readable reason when `exceeded` is true. */
  message?: string;
  /**
   * One or more 'warn' budgets are exhausted. Unlike `exceeded`, this never
   * blocks the request — it's a signal for the caller to log/notify so a
   * 'warn' budget isn't a silent no-op (it used to never even be queried).
   */
  warnings?: string[];
  /** Budgets at or past 80% this period, for the budget alerts. */
  crossings?: BudgetCrossing[];
}

/** The start of a budget's current period: UTC midnight, the Monday of a week, the 1st of a month. */
export function startOfBudgetPeriod(period: Period, now: Date = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === 'month') start.setUTCDate(1);
  return start;
}

/** When a budget's current period ends and its spend starts again from 0. */
export function budgetPeriodResetsAt(period: Period, now: Date = new Date()): Date {
  const next = startOfBudgetPeriod(period, now);
  if (period === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCDate(next.getUTCDate() + (period === 'week' ? 7 : 1));
  return next;
}

export interface BudgetSpend {
  spentUsd: number;
  periodStart: Date;
  resetsAt: Date;
}

/**
 * Each budget's spend in its current period, in input order: the number
 * `checkBudget` compares with the limit. GET /gateway/budgets reports these
 * same numbers, so the meter and the gate cannot disagree (KRTX-1725). A
 * member budget counts the requests of its member only.
 *
 * One statement for any number of budgets: one filtered sum per budget over
 * one scan of the project's rows since the earliest period start. A statement
 * per budget, all in parallel, held every connection of the request pool that
 * the gate's own check waits on.
 * ponytail: one FILTER per budget per row; group by actor_user_id if a project
 * ever carries hundreds of member budgets.
 */
export async function budgetSpends(
  projectId: string,
  budgets: ReadonlyArray<{ scope: string; subjectUserId: string | null; period: string }>,
  now: Date = new Date(),
): Promise<BudgetSpend[]> {
  if (budgets.length === 0) return [];
  const windows = budgets.map((budget) => {
    const period = budget.period as Period;
    const periodStart = startOfBudgetPeriod(period, now);
    const inPeriod = gte(gatewayRequestLogs.createdAt, periodStart);
    return {
      periodStart,
      resetsAt: budgetPeriodResetsAt(period, now),
      rows:
        budget.scope === 'member' && budget.subjectUserId
          ? sql`${inPeriod} and ${eq(gatewayRequestLogs.actorUserId, budget.subjectUserId)}`
          : inPeriod,
    };
  });
  const from = new Date(Math.min(...windows.map((w) => w.periodStart.getTime())));
  const [agg] = await db
    // TOTAL spend, not the Kortix-billed slice. A gateway budget caps what a
    // project spends on inference; measuring it with `final_cost` alone made
    // every budget on a BYOK project permanently inert, because BYOK routes
    // resolve to `billingMode: 'none'` with `markup: 0` and bill 0 no matter
    // how many tokens they burn. See shared/llm-spend.ts.
    .select(Object.fromEntries(windows.map((w, i) => [`b${i}`, totalSpendWhereSql(w.rows)])))
    .from(gatewayRequestLogs)
    .where(and(eq(gatewayRequestLogs.projectId, projectId), gte(gatewayRequestLogs.createdAt, from)));
  return windows.map((w, i) => ({
    spentUsd: agg?.[`b${i}`] ?? 0,
    periodStart: w.periodStart,
    resetsAt: w.resetsAt,
  }));
}

// ─── In-flight admission reservation for 'block' budgets ───────────────────
//
// checkBudget's `spent` comes from gatewayRequestLogs, which is only written
// once a request fully SETTLES (post-stream, for a streaming completion that
// can run for tens of seconds to the pipeline's 240s retry deadline). Without
// this, N concurrent requests admitted inside that window all read the same
// stale `spent` and all pass — the exact scenario this audit flagged (e.g. 20
// concurrent agent sessions against a project 'block' budget).
//
// This is a PRAGMATIC, honestly-scoped slice of the full fix (a real
// reservation ledger with release-on-settle, tracked as a follow-up — see PR
// description): a conservative FIXED reservation per in-flight admission,
// held in-process (no schema change, no cross-request plumbing) and expired
// automatically via TTL rather than explicitly released. It bounds the
// overshoot to (concurrent admissions × RESERVATION_USD) instead of the
// previous unbounded (concurrency × real average cost over the whole request
// lifetime) — not a perfect fix (RESERVATION_USD is an estimate, not the
// request's real eventual cost), but a real, honest improvement over "no
// bound at all". Resets on process restart; in a multi-pod deployment the
// bound is per-pod, not global — documented here rather than hidden.
//
// A settled request releases its reservation (`releaseBudgetReservation`,
// called from the usage settlement): its cost is now in the logged spend, so
// keeping the $0.50 as well counted it twice and denied a budget far below its
// limit. The TTL remains the backstop for a request that never settles on this
// process (crash, or a settlement handled by another replica).
const RESERVATION_USD = 0.5;
const RESERVATION_TTL_MS = 5 * 60_000;

interface Reservation {
  expiresAt: number;
}
const reservationsByKey = new Map<string, Reservation[]>();

function reservationKey(projectId: string, subjectUserId: string | null): string {
  return `${projectId}\u0000${subjectUserId ?? ''}`;
}

/** Sum of still-active (non-expired) reservations for a project/member key, purging expired ones as a side effect. */
function activeReservedUsd(key: string): number {
  const list = reservationsByKey.get(key);
  if (!list || list.length === 0) return 0;
  const now = Date.now();
  const active = list.filter((r) => r.expiresAt > now);
  if (active.length === 0) reservationsByKey.delete(key);
  else if (active.length !== list.length) reservationsByKey.set(key, active);
  return active.length * RESERVATION_USD;
}

function addReservation(key: string): void {
  const list = reservationsByKey.get(key) ?? [];
  list.push({ expiresAt: Date.now() + RESERVATION_TTL_MS });
  reservationsByKey.set(key, list);
}

/**
 * Release the oldest active reservation on each block-budget key this request
 * could have reserved: the project key and the member key. Called once per
 * settled request. A key with no reservation on this process is left alone.
 */
export function releaseBudgetReservation(projectId: string | null | undefined, userId: string | null | undefined): void {
  if (!projectId) return;
  const keys = [reservationKey(projectId, null)];
  if (userId) keys.push(reservationKey(projectId, userId));
  const now = Date.now();
  for (const key of keys) {
    const list = reservationsByKey.get(key);
    if (!list) continue;
    const index = list.findIndex((r) => r.expiresAt > now);
    if (index >= 0) list.splice(index, 1);
    const active = list.filter((r) => r.expiresAt > now);
    if (active.length === 0) reservationsByKey.delete(key);
    else reservationsByKey.set(key, active);
  }
}

/** Test-only seam: clears every in-flight reservation. */
export function __resetBudgetReservationsForTests(): void {
  reservationsByKey.clear();
}

/** The budget refusal or warning a caller reads, in credits (1 credit = $0.01). */
function budgetExhaustedMessage(who: string, limitUsd: number, spentUsd: number, period: Period): string {
  return `${who} gateway budget (${formatUsdAsCredits(limitUsd)} credits/${period}) is exhausted — ${formatUsdAsCredits(spentUsd)} credits used this ${period}.`;
}


/**
 * Evaluate the project's gateway budgets of one action. 'block' runs at
 * admission: the first exhausted one denies the request, and each admitted
 * request reserves against it. 'warn' never denies, so it runs at settlement,
 * after the response: its spend query (up to ~1 s on a busy project) is off
 * the latency path. An exhausted 'warn' budget goes into `warnings`.
 */
export async function checkBudget(
  principal: AuthedPrincipal,
  action: 'block' | 'warn' = 'block',
): Promise<BudgetCheckResult> {
  if (!principal.projectId) return { exceeded: false };

  const budgets = await db
    .select()
    .from(gatewayBudgets)
    .where(eq(gatewayBudgets.projectId, principal.projectId));
  if (budgets.length === 0) return { exceeded: false };

  const now = new Date();
  const warnings: string[] = [];
  const crossings: BudgetCrossing[] = [];
  const signals = () => ({
    ...(warnings.length ? { warnings } : {}),
    ...(crossings.length ? { crossings } : {}),
  });
  for (const b of budgets) {
    if (b.action !== action) continue;
    if (b.scope === 'member' && b.subjectUserId !== principal.userId) continue;
    const subject = b.scope === 'member' ? b.subjectUserId : null;
    const spent = (await budgetSpends(principal.projectId, [b], now))[0]?.spentUsd ?? 0;
    const limit = Number(b.limitUsd);
    const threshold = spent >= limit ? 100 : spent >= limit * 0.8 ? 80 : null;
    if (threshold && b.budgetId) {
      crossings.push({
        budgetId: b.budgetId,
        threshold,
        scope: b.scope as BudgetCrossing['scope'],
        subjectUserId: subject,
        period: b.period as Period,
        action: b.action as BudgetCrossing['action'],
        limitUsd: limit,
        spentUsd: spent,
      });
    }

    if (b.action === 'block') {
      // Fold in other admissions still in flight for this exact project/
      // member key — see the reservation comment above.
      const key = reservationKey(principal.projectId, subject);
      const effectiveSpent = spent + activeReservedUsd(key);
      if (effectiveSpent >= limit) {
        const who = b.scope === 'member' ? 'Your' : "This project's";
        return {
          exceeded: true,
          message: budgetExhaustedMessage(who, limit, spent, b.period),
          ...signals(),
        };
      }
      // Reserve for THIS admission before returning — the next concurrent
      // check (even one that started a moment ago and hasn't settled) will
      // see it.
      addReservation(key);
      continue;
    }

    // action === 'warn': never blocks and never needs a reservation.
    if (spent >= limit) {
      const who = b.scope === 'member' ? 'Your' : "This project's";
      warnings.push(
        budgetExhaustedMessage(who, limit, spent, b.period),
      );
    }
  }
  return { exceeded: false, ...signals() };
}
