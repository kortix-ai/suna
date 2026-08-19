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
 * 1. Every `serial` and every `global` flow goes to shard 1. `global` flows
 *    (ADM-19, BILL-13, CONN-5) mutate platform-wide state that all shards share
 *    — two jobs running them at once would corrupt each other. `serial` flows
 *    mutate their own run's OWNER/platform-admin principals; each shard builds
 *    its own world, so those are technically shard-safe, but pinning the whole
 *    non-parallel tail to one shard keeps ONE job responsible for it and lets
 *    the model below give the other shards proportionally more parallel work.
 * 2. The remaining flows are bin-packed longest-processing-time-first onto the
 *    shard with the lowest projected load, ties broken by shard index then flow
 *    id. LPT is deterministic given the same registry, so every job computes an
 *    identical partition without coordinating.
 *
 * The cost model is in worker-seconds and uses the flow's declared `timeoutMs`
 * (default 120_000, matching `runner.ts`'s `withTimeout` fallback) as a static
 * proxy for duration. It is a ceiling, not a measurement — good enough to keep
 * the expensive sandbox flows from piling onto one shard, and it needs no
 * results artifact to stay current. A serial flow occupies a whole shard while
 * the other workers idle, so it is charged `SERIAL_WORKER_PENALTY` times its
 * weight; a parallel flow is charged once.
 */
import type { RegisteredFlow } from './flow';

/** `runner.ts:161` — `withTimeout(f.fn(ctx), f.meta.timeoutMs ?? 120_000, f.id)`. */
export const DEFAULT_FLOW_WEIGHT_MS = 120_000;

/**
 * Models the per-shard API worker count: a serial flow blocks the shard for its
 * whole duration while the other workers idle, so it costs the shard that many
 * worker-seconds. Kept equal to the `KE2E_API_WORKERS` the release gate gives
 * each API shard.
 */
export const SERIAL_WORKER_PENALTY = 3;

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

  const parallel = flows
    .filter((flow) => !isPinnedToFirstShard(flow))
    .sort((a, b) => {
      const delta = flowWeightMs(b) - flowWeightMs(a);
      return delta !== 0 ? delta : a.id.localeCompare(b.id, undefined, { numeric: true });
    });

  for (const flow of parallel) {
    let target = 0;
    for (let i = 1; i < spec.total; i++) {
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
