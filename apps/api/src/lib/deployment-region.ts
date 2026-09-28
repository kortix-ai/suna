/**
 * Best-effort AWS region for THIS API process and for its database.
 *
 * ─── Why (the turn-latency spec (PR #7840), 2026-09-27) ───────────────────────────
 * The spec's own §1 baseline turned out to be dominated by geography: dev
 * runs the API in us-west-2 against a database in us-east-2 — every
 * authenticated read crosses a continent and costs 45-85x the SAME query
 * colocated in prod (London). A benchmark that reports a latency number
 * without saying where the two halves live measures a network problem and
 * calls it a code path. `/health` surfaces both regions (see `index.ts`) so
 * `pnpm test -- --latency` can print the topology, not just a duration.
 *
 * Both functions are pure and return null rather than guess when the signal
 * is absent — a wrong region name is worse than an honest "unknown".
 */

/** ECS/Fargate sets one of these automatically; never guess if neither is set. */
export function apiRegion(env: NodeJS.ProcessEnv = process.env): string | null {
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  return region ? region : null;
}

/**
 * RDS/Aurora endpoints embed their region in the hostname
 * (`<id>.<cluster-id>.<region>.rds.amazonaws.com`). Extracting it from the
 * connection string leaks nothing beyond that region name — the returned
 * value is never the host, user, or password, only the matched region
 * segment — so it is safe to serve on an unauthenticated health endpoint.
 * A non-RDS host (local Supabase, a self-hosted Postgres) returns null.
 */
const RDS_HOST_REGION = /\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com(?::\d+)?/i;

export function databaseRegion(databaseUrl: string): string | null {
  const match = RDS_HOST_REGION.exec(databaseUrl);
  return match?.[1]?.toLowerCase() ?? null;
}
