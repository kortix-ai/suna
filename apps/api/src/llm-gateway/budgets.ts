import { and, eq, sql } from 'drizzle-orm';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { db } from '../shared/db';
import { totalSpendSql } from '../shared/llm-spend';

type Period = 'day' | 'week' | 'month';

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
}

async function spendForPeriod(
  projectId: string,
  subjectUserId: string | null,
  period: Period,
): Promise<number> {
  const conds = [
    eq(gatewayRequestLogs.projectId, projectId),
    sql`${gatewayRequestLogs.createdAt} >= date_trunc(${period}, now())`,
  ];
  if (subjectUserId) conds.push(eq(gatewayRequestLogs.actorUserId, subjectUserId));
  const [agg] = await db
    // TOTAL spend, not the Kortix-billed slice. A gateway budget caps what a
    // project spends on inference; measuring it with `final_cost` alone made
    // every budget on a BYOK project permanently inert, because BYOK routes
    // resolve to `billingMode: 'none'` with `markup: 0` and bill 0 no matter
    // how many tokens they burn. See shared/llm-spend.ts.
    .select({ cost: totalSpendSql })
    .from(gatewayRequestLogs)
    .where(and(...conds));
  return agg?.cost ?? 0;
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

/**
 * Evaluate every gateway budget scoped to the caller's project (both 'block'
 * and 'warn' actions — a previous version only ever queried action='block',
 * so a 'warn' budget was fetched nowhere and did nothing at all, even though
 * the create-budget API lets an admin configure one). A 'block' budget that's
 * exhausted short-circuits with `exceeded: true` (mirrors the prior
 * behavior). A 'warn' budget that's exhausted never blocks — it's collected
 * into `warnings` so the caller can surface/log it instead of silently
 * dropping it.
 */
export async function checkBudget(principal: AuthedPrincipal): Promise<BudgetCheckResult> {
  if (!principal.projectId) return { exceeded: false };

  const budgets = await db
    .select()
    .from(gatewayBudgets)
    .where(eq(gatewayBudgets.projectId, principal.projectId));
  if (budgets.length === 0) return { exceeded: false };

  const warnings: string[] = [];
  for (const b of budgets) {
    if (b.scope === 'member' && b.subjectUserId !== principal.userId) continue;
    const subject = b.scope === 'member' ? b.subjectUserId : null;
    const spent = await spendForPeriod(principal.projectId, subject, b.period as Period);
    const limit = Number(b.limitUsd);

    if (b.action === 'block') {
      // Fold in other admissions still in flight for this exact project/
      // member key — see the reservation comment above spendForPeriod.
      const key = reservationKey(principal.projectId, subject);
      const effectiveSpent = spent + activeReservedUsd(key);
      if (effectiveSpent >= limit) {
        const who = b.scope === 'member' ? 'Your' : "This project's";
        return {
          exceeded: true,
          message: `${who} gateway budget ($${limit}/${b.period}) is exhausted — $${spent.toFixed(2)} used this ${b.period}.`,
          ...(warnings.length ? { warnings } : {}),
        };
      }
      // Reserve for THIS admission before returning — the next concurrent
      // check (even one that started a moment ago and hasn't settled) will
      // see it.
      addReservation(key);
      continue;
    }

    // action === 'warn': never blocks and never needs a reservation (nothing
    // is gated on it) — evaluated straight off logged spend.
    if (spent >= limit) {
      const who = b.scope === 'member' ? 'Your' : "This project's";
      warnings.push(
        `${who} gateway budget ($${limit}/${b.period}) is exhausted — $${spent.toFixed(2)} used this ${b.period}.`,
      );
    }
  }
  return { exceeded: false, ...(warnings.length ? { warnings } : {}) };
}
