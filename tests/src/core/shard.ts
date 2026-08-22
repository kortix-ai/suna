/**
 * Deterministic flow sharding for the release gate.
 *
 * `.github/workflows/tests-release.yml` runs the deployed API suite as N
 * parallel GitHub jobs. Each job re-discovers the SAME flow registry and asks
 * this planner which flows belong to its shard, so the partition is computed
 * from the live registry rather than from a hand-maintained list: a newly added
 * flow always lands in exactly one shard and can never fall out of the gate.
 *
 * Two rules, in order:
 *
 * 1. Every `serial` and every `global` flow goes to shard 1, and — whenever such
 *    a flow exists and there is more than one shard — shard 1 gets NOTHING else.
 *    `global` flows (ADM-19, BILL-13, CONN-5) mutate platform-wide state that
 *    all shards share, so two jobs running them at once would corrupt each
 *    other. `serial` flows mutate their own run's OWNER/platform-admin
 *    principals. Both kinds run strictly one-at-a-time (`runner.ts` drains them
 *    after the parallel lanes), so any parallel flow sharing their shard waits
 *    behind a queue it cannot help drain. Giving the tail its own runner is what
 *    lets the remaining shards be sized purely by parallel work.
 * 2. The remaining flows are bin-packed longest-processing-time-first onto the
 *    eligible shard with the lowest projected load, ties broken by shard index
 *    then flow id. LPT is deterministic given the same registry, so every job
 *    computes an identical partition without coordinating.
 *
 * The cost model is in worker-seconds and uses the flow's declared `timeoutMs`
 * (default 120_000, matching `runner.ts`'s `withTimeout` fallback) as a static
 * proxy for duration. It is a ceiling, not a measurement — good enough to keep
 * the expensive sandbox flows from piling onto one shard, and it needs no
 * results artifact to stay current. A serial flow occupies a whole shard while
 * the other workers idle, so it is charged `SERIAL_WORKER_PENALTY` times its
 * weight; a parallel flow is charged once. Read a projected load as a wall-clock
 * ceiling of `load / KE2E_API_WORKERS`, uniformly across every shard.
 */
import type { RegisteredFlow } from './flow';

/** `runner.ts:161` — `withTimeout(f.fn(ctx), f.meta.timeoutMs ?? 120_000, f.id)`. */
export const DEFAULT_FLOW_WEIGHT_MS = 120_000;

/**
 * Models the per-shard API worker count: a serial flow blocks the shard for its
 * whole duration while the other workers idle, so it costs the shard that many
 * worker-seconds. Must equal the `KE2E_API_WORKERS` the release gate gives each
 * API shard (`tests-release.yml`), or a projected load no longer converts to a
 * wall-clock ceiling by the same divisor on every shard. It was 3 while the gate
 * ran 3 API workers; the gate now runs 2.
 *
 * This value cannot change the partition. Rule 1 gives the serial tail its own
 * shard, so the only load it inflates is a shard that receives no bin-packed
 * work — it is a reporting constant, not a packing input.
 */
export const SERIAL_WORKER_PENALTY = 2;

export interface ShardSpec {
  current: number;
  total: number;
}

export interface ShardPlan {
  /** Flow ids assigned to `spec.current`, sorted for a stable command line. */
  ids: string[];
  /** Projected worker-second load of every shard, indexed from shard 1. */
  loads: number[];
}

/** Parse `CURRENT/TOTAL`. Throws on anything that is not a usable shard spec. */
export function parseShardSpec(value: string): ShardSpec {
  const match = value.match(/^(\d+)\/(\d+)$/);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !Number.isInteger(current) || !Number.isInteger(total)) {
    throw new Error(`--shard must use CURRENT/TOTAL, received "${value}"`);
  }
  if (total < 1 || current < 1 || current > total) {
    throw new Error(`--shard must satisfy 1 <= CURRENT <= TOTAL, received "${value}"`);
  }
  return { current, total };
}

export function flowWeightMs(flow: RegisteredFlow): number {
  const declared = flow.meta.timeoutMs;
  return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_FLOW_WEIGHT_MS;
}

export function isPinnedToFirstShard(flow: RegisteredFlow): boolean {
  return Boolean(flow.meta.serial) || Boolean(flow.meta.global);
}

/**
 * Assign every flow to a shard and return the ids belonging to `spec.current`.
 * Total across all shards is a partition: every input flow appears exactly once.
 */
export function planShard(flows: RegisteredFlow[], spec: ShardSpec): ShardPlan {
  const loads = new Array<number>(spec.total).fill(0);
  const assigned = new Array<string[]>(spec.total);
  for (let i = 0; i < spec.total; i++) assigned[i] = [];

  const pinned = flows.filter(isPinnedToFirstShard);
  for (const flow of pinned) {
    assigned[0].push(flow.id);
    loads[0] += flowWeightMs(flow) * SERIAL_WORKER_PENALTY;
  }

  // Rule 1: the serial tail owns shard 1 alone. Two escapes, both required to
  // keep the planner total — a shard that can receive nothing must not exist:
  // at `--shard 1/1` shard 1 is the only shard there is, and a registry with no
  // serial or global flow has no tail to isolate.
  const firstShardIsReserved = pinned.length > 0 && spec.total > 1;
  const packStart = firstShardIsReserved ? 1 : 0;

  const parallel = flows
    .filter((flow) => !isPinnedToFirstShard(flow))
    .sort((a, b) => {
      const delta = flowWeightMs(b) - flowWeightMs(a);
      return delta !== 0 ? delta : a.id.localeCompare(b.id, undefined, { numeric: true });
    });

  for (const flow of parallel) {
    let target = packStart;
    for (let i = packStart + 1; i < spec.total; i++) {
      if (loads[i] < loads[target]) target = i;
    }
    assigned[target].push(flow.id);
    loads[target] += flowWeightMs(flow);
  }

  return {
    ids: assigned[spec.current - 1].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
    loads,
  };
}
