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

/**
 * Prod allows 50% rolling-deploy headroom on the ECS API service:
 * `deployment_maximum_percent = 150`, so at full scale the fleet can reach
 * floor(desired × 1.5) = 15 tasks — the envelope counts that peak (10 × 1.5;
 * the old 200% overlap implied 20). 100% is not an option: Availability Zone
 * Rebalancing is enabled on the prod API service (out-of-band, unmanaged by
 * Terraform) and AWS rejects `maximumPercent <= 100` at UpdateService time —
 * the failed v0.13.54 prod apply (2026-10-11). The paired
 * `deployment_minimum_healthy_percent = 50` keeps ceil(desired × 0.5) tasks
 * healthy so replacements actually run (AWS rounds minimum UP, maximum
 * DOWN), and any capacity dip it allows only shrinks this envelope — see
 * the Terraform cross-check in `database-capacity.test.ts`. Dev and staging
 * keep the module's 200% default for faster deploys; their DB budgets are
 * separate.
 */
export const ROLLING_TASK_OVERLAP = 1.5;

/**
 * Slots reserved for Supabase, operators, migrations, and request-scoped probes.
 * The invariant below leaves a further 5-slot buffer beyond this reserve
 * (15 before the KRTX-2020 raise spent 10 of them on the request pool).
 */
export const PROD_DB_NON_API_RESERVE = 32;

export const PROD_DB_ROLLING_CONNECTION_CEILING =
  PROD_API_MAX_TASKS *
  ROLLING_TASK_OVERLAP *
  (DEFAULT_DB_POOL_MAX + DEFAULT_AUDIT_POOL_MAX + LEADER_ELECTION_POOL_MAX + PG_BROADCAST_POOL_MAX);
