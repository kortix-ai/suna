import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { gatewayBudgets, gatewayRequestLogs, gatewaySpendDaily, gatewaySpendPendingDays } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { db } from '../shared/db';
import { rowTotalSpendSql, totalSpendSql, totalSpendWhereSql } from '../shared/llm-spend';
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

/** gateway_spend_daily's key for a log row with no actor. */
const NO_ACTOR = '00000000-0000-0000-0000-000000000000';
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * True when gateway_spend_daily is complete for every UTC day from `from`:
 * no day in gateway_spend_pending_days (the days before the trigger and the
 * day it was installed). Otherwise the readers sum gateway_request_logs.
 */
async function dailyTotalsComplete(from: Date): Promise<boolean> {
  const [pending] = await db
    .select({ day: gatewaySpendPendingDays.day })
    .from(gatewaySpendPendingDays)
    .where(gte(gatewaySpendPendingDays.day, utcDay(from)))
    .limit(1);
  return !pending;
}

/**
 * Each budget's spend in its current period, in input order: the number
 * `checkBudget` compares with the limit. GET /gateway/budgets reports these
 * same numbers, so the meter and the gate cannot disagree (KRTX-1725). A
 * member budget counts the requests of its member only.
 *
 * One statement for any number of budgets, one filtered sum per budget. It
 * reads the running total gateway_spend_daily (one row per UTC day and actor),
 * or, while a day of the window is still pending, the log rows as before.
 * Budget periods start at UTC midnight, so whole UTC days cover them exactly.
 */
export async function budgetSpends(
  projectId: string,
  budgets: ReadonlyArray<{ scope: string; subjectUserId: string | null; period: string }>,
  now: Date = new Date(),
): Promise<BudgetSpend[]> {
  if (budgets.length === 0) return [];
  const windows = budgets.map((budget) => {
    const period = budget.period as Period;
    return {
      periodStart: startOfBudgetPeriod(period, now),
      resetsAt: budgetPeriodResetsAt(period, now),
      subject: budget.scope === 'member' && budget.subjectUserId ? budget.subjectUserId : null,
    };
  });
  const from = new Date(Math.min(...windows.map((w) => w.periodStart.getTime())));

  // The pending-day check rides in the same statement as the sum, so the
  // admission gate pays one round trip once every day has settled.
  const d = gatewaySpendDaily;
  const [daily] = await db
    .select({
      pending: sql<boolean>`exists (select 1 from ${gatewaySpendPendingDays} where ${gte(gatewaySpendPendingDays.day, utcDay(from))})`,
      ...Object.fromEntries(
        windows.map((w, i) => {
          const rows = w.subject
            ? sql`${gte(d.day, utcDay(w.periodStart))} and ${eq(d.actorUserId, w.subject)}`
            : gte(d.day, utcDay(w.periodStart));
          return [`b${i}`, sql<number>`coalesce(sum(${d.totalCost}) filter (where ${rows}), 0)::float8`];
        }),
      ),
    })
    .from(d)
    .where(and(eq(d.projectId, projectId), gte(d.day, utcDay(from))));
  let agg = daily as Record<string, unknown> | undefined;
  if (daily?.pending) {
    [agg] = await db
      // TOTAL spend, not the Kortix-billed slice. A gateway budget caps what a
      // project spends on inference; measuring it with `final_cost` alone made
      // every budget on a BYOK project permanently inert, because BYOK routes
      // resolve to `billingMode: 'none'` with `markup: 0` and bill 0 no matter
      // how many tokens they burn. See shared/llm-spend.ts.
      .select(
        Object.fromEntries(
          windows.map((w, i) => {
            const inPeriod = gte(gatewayRequestLogs.createdAt, w.periodStart);
            const rows = w.subject
              ? sql`${inPeriod} and ${eq(gatewayRequestLogs.actorUserId, w.subject)}`
              : inPeriod;
            return [`b${i}`, totalSpendWhereSql(rows)];
          }),
        ),
      )
      .from(gatewayRequestLogs)
      .where(and(eq(gatewayRequestLogs.projectId, projectId), gte(gatewayRequestLogs.createdAt, from)));
  }
  return windows.map((w, i) => ({
    spentUsd: Number(agg?.[`b${i}`] ?? 0),
    periodStart: w.periodStart,
    resetsAt: w.resetsAt,
  }));
}

export interface MonthToDateGatewaySpend {
  project: { requests: number; cost: number };
  /** Per actor, most spend first. Rows without an actor are left out. */
  members: { userId: string; requests: number; cost: number; tokens: number }[];
}

/**
 * Month-to-date requests and total spend of a project, and per member. With
 * `onlyUserId`, `members` holds that member only; only `null` means every
 * member, so an empty id matches no row (fails closed). Reads gateway_spend_daily,
 * or the log rows while a day of the month is pending.
 */
export async function monthToDateGatewaySpend(
  projectId: string,
  onlyUserId: string | null,
  now: Date = new Date(),
): Promise<MonthToDateGatewaySpend> {
  const monthStart = startOfBudgetPeriod('month', now);
  if (await dailyTotalsComplete(monthStart)) {
    const d = gatewaySpendDaily;
    const rows = await db
      .select({
        userId: d.actorUserId,
        requests: sql<number>`sum(${d.requests})::int`,
        cost: sql<number>`sum(${d.totalCost})::float8`,
        tokens: sql<number>`sum(${d.tokens})::float8`,
        // The project totals over every actor row, as one exact numeric sum.
        projectRequests: sql<number>`(sum(sum(${d.requests})) over ())::int`,
        projectCost: sql<number>`(sum(sum(${d.totalCost})) over ())::float8`,
      })
      .from(d)
      .where(and(eq(d.projectId, projectId), gte(d.day, utcDay(monthStart))))
      .groupBy(d.actorUserId);
    const project = { requests: rows[0]?.projectRequests ?? 0, cost: rows[0]?.projectCost ?? 0 };
    const members = rows
      .filter((r) => r.userId !== NO_ACTOR && (onlyUserId === null || r.userId === onlyUserId))
      .map(({ userId, requests, cost, tokens }) => ({ userId, requests, cost, tokens }))
      .sort((a, b) => b.cost - a.cost);
    return { project, members };
  }

  const inMonth = and(eq(gatewayRequestLogs.projectId, projectId), gte(gatewayRequestLogs.createdAt, monthStart));
  const members = await db
    .select({
      userId: sql<string>`${gatewayRequestLogs.actorUserId}`,
      requests: sql<number>`count(*)::int`,
      // Budgets cap what a project SPENDS, so per-member spend here is the
      // same total-spend figure the budget gate enforces on — not the
      // Kortix-billed slice, which is 0 on every BYOK request.
      cost: totalSpendSql,
      tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)::float8`,
    })
    .from(gatewayRequestLogs)
    .where(
      and(
        inMonth,
        onlyUserId !== null
          ? eq(gatewayRequestLogs.actorUserId, onlyUserId)
          : sql`${gatewayRequestLogs.actorUserId} is not null`,
      ),
    )
    .groupBy(gatewayRequestLogs.actorUserId)
    .orderBy(desc(totalSpendSql));
  const [project] = await db
    .select({ requests: sql<number>`count(*)::int`, cost: totalSpendSql })
    .from(gatewayRequestLogs)
    .where(inMonth);
  return { project: { requests: project?.requests ?? 0, cost: project?.cost ?? 0 }, members };
}

/**
 * Recompute one closed pending UTC day of gateway_spend_daily from the log
 * rows and take it off the pending list, in one transaction. Returns false
 * when no closed day is pending. A day counts as closed 10 minutes after UTC
 * midnight: a log row's created_at is its INSERT's start, and the audit pool
 * that runs the INSERT (DB_AUDIT_STATEMENT_TIMEOUT_MS, 10 s by default) ends
 * every INSERT long before that. `skip locked`
 * lets a second runner pass over a day in progress.
 */
export async function settleGatewaySpendDay(): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [pending] = await tx.execute<{ day: string }>(sql`
      delete from kortix.gateway_spend_pending_days
      where day = (
        select day from kortix.gateway_spend_pending_days
        where day < ((now() - interval '10 minutes') at time zone 'UTC')::date
        order by day desc
        limit 1
        for update skip locked
      )
      returning day::text`);
    if (!pending) return false;
    await tx.execute(sql`delete from kortix.gateway_spend_daily where day = ${pending.day}::date`);
    await tx.execute(sql`
      insert into kortix.gateway_spend_daily (project_id, day, actor_user_id, requests, total_cost, tokens)
      select project_id, ${pending.day}::date, coalesce(actor_user_id, ${NO_ACTOR}::uuid), count(*)::int,
             sum(${rowTotalSpendSql}), sum(input_tokens::bigint + output_tokens)
      from kortix.gateway_request_logs
      where project_id is not null
        and created_at >= (${pending.day}::date)::timestamp at time zone 'UTC'
        and created_at < (${pending.day}::date + 1)::timestamp at time zone 'UTC'
      group by 1, 3`);
    return true;
  });
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
 * after the response, off the latency path. An exhausted 'warn' budget goes into `warnings`.
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
  const applicable = budgets.filter(
    (b) => b.action === action && !(b.scope === 'member' && b.subjectUserId !== principal.userId),
  );
  if (applicable.length === 0) return { exceeded: false };
  // Every budget of this action in one statement.
  const spends = await budgetSpends(principal.projectId, applicable, now);
  for (const [i, b] of applicable.entries()) {
    const subject = b.scope === 'member' ? b.subjectUserId : null;
    const spent = spends[i]?.spentUsd ?? 0;
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
