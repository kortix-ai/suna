import { DEFAULT_DB_POOL_MAX } from '@kortix/db/connection-defaults';

/**
 * Connection budgets for one API task.
 *
 * Keep these values in one pure module. The production rollout-capacity test
 * must account for every long-lived pool. The invariant, the measured
 * per-statement cost, and the re-check procedure for raising any of these
 * ceilings live in the learnings ledger entry
 * `.agents/skills/learnings/entries/2026-10-09T100152Z-raise-one-database-pool-at-a-time-inside-the-rolling-fleet-b.md`
 * — read it before changing `DEFAULT_DB_POOL_MAX` or any other pool constant
 * here: one pool, one step, re-checked on prod before the next.
 */
export { DEFAULT_DB_POOL_MAX };
export const DEFAULT_AUDIT_POOL_MAX = 2;
export const LEADER_ELECTION_POOL_MAX = 1;
/**
 * The base-move LISTEN/NOTIFY subscription (`./pg-broadcast.ts`). Opened once,
 * awaited, on EVERY replica at boot (not leader-gated) and never released — a
 * long-lived per-task connection exactly like `LEADER_ELECTION_POOL_MAX`, and
 * omitted from this budget until the 2026-09-27 incident (SQLSTATE `53300`
 * during the v0.13.35 rolling deploy).
 */
export const PG_BROADCAST_POOL_MAX = 1;

/** Production PostgreSQL exposes 240 slots and reserves 3 for superusers. */
export const PROD_DB_USABLE_CONNECTIONS = 237;

/** ECS can autoscale the production API service to 10 tasks. */
export const PROD_API_MAX_TASKS = 10;

/** ECS permits a 200% rolling deployment: 10 old tasks plus 10 new tasks. */
export const ROLLING_TASK_OVERLAP = 2;

/**
 * Slots reserved for Supabase, operators, migrations, and request-scoped probes.
 * The invariant below leaves a further 5-slot buffer beyond this reserve
 * (15 before the KRTX-2020 raise spent 10 of them on the request pool).
 */
export const PROD_DB_NON_API_RESERVE = 32;

/**
 * Long-lived connections of one web task (`KORTIX_PROCESS_ROLE=web`). It
 * never joins the leader election, so it never opens that client.
 */
export const WEB_TASK_CONNECTIONS = DEFAULT_DB_POOL_MAX + DEFAULT_AUDIT_POOL_MAX + PG_BROADCAST_POOL_MAX;

/** One worker task (`src/worker.ts`), or an API task with role `all`, also holds the leader-election client. */
export const LEASE_TASK_CONNECTIONS = WEB_TASK_CONNECTIONS + LEADER_ELECTION_POOL_MAX;

/** The worker service runs one task; a deploy overlaps a second. */
export const PROD_WORKER_TASKS = 1;

/**
 * The rolling peak: every web task and every worker task overlapping its
 * replacement. 10 × 2 × 9 + 1 × 2 × 10 = 200.
 *
 * Two rollouts reach the same 200 and no more, because ecs-deploy.sh rolls the
 * worker before the API, one after the other:
 * - the release that switches the API to `web`: 10 old `all` tasks × 10 + 10
 *   new `web` tasks × 9 + the worker's 10 = 200;
 * - a worker roll: 10 web tasks × 9 + 2 worker tasks × 10 = 110.
 *
 * One path goes over: a worker roll that fails while the API still runs `all`
 * and sits at 10 tasks. The API then rolls as `all` (20 × 10) beside the old
 * worker (10) = 210 until ecs-deploy.sh scales the worker to 0 after the API
 * roll.
 */
export const PROD_DB_ROLLING_CONNECTION_CEILING =
  PROD_API_MAX_TASKS * ROLLING_TASK_OVERLAP * WEB_TASK_CONNECTIONS +
  PROD_WORKER_TASKS * ROLLING_TASK_OVERLAP * LEASE_TASK_CONNECTIONS;
