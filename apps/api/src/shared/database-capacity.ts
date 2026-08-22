import { DEFAULT_DB_POOL_MAX } from '@kortix/db/connection-defaults';

/**
 * Connection budgets for one API task.
 *
 * Keep these values in one pure module. The production rollout-capacity test
 * must account for every long-lived pool and the transient schema probe.
 */
export { DEFAULT_DB_POOL_MAX };
export const DEFAULT_AUDIT_POOL_MAX = 2;
export const LEADER_ELECTION_POOL_MAX = 1;
export const SCHEMA_CHECK_POOL_MAX = 1;

/** Production PostgreSQL exposes 240 slots and reserves 3 for superusers. */
export const PROD_DB_USABLE_CONNECTIONS = 237;

/** ECS can autoscale the production API service to 10 tasks. */
export const PROD_API_MAX_TASKS = 10;

/** ECS permits a 200% rolling deployment: 10 old tasks plus 10 new tasks. */
export const ROLLING_TASK_OVERLAP = 2;

/**
 * Slots reserved for Supabase, operators, migrations, and request-scoped probes.
 * The invariant below leaves a further 15-slot buffer beyond this reserve.
 */
export const PROD_DB_NON_API_RESERVE = 32;

const rollingLongLivedConnections =
  PROD_API_MAX_TASKS *
  ROLLING_TASK_OVERLAP *
  (DEFAULT_DB_POOL_MAX + DEFAULT_AUDIT_POOL_MAX + LEADER_ELECTION_POOL_MAX);

// Only the 10 starting tasks run the transient schema probe. Old tasks have
// completed it before the deployment begins.
const rollingSchemaProbeConnections = PROD_API_MAX_TASKS * SCHEMA_CHECK_POOL_MAX;

export const PROD_DB_ROLLING_CONNECTION_CEILING =
  rollingLongLivedConnections + rollingSchemaProbeConnections;
