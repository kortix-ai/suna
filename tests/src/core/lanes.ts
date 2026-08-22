import { mapWithConcurrency } from './concurrency';
import type { RegisteredFlow } from './flow';

export function partitionParallelFlows(flows: RegisteredFlow[]): {
  apiLane: RegisteredFlow[];
  sandboxLane: RegisteredFlow[];
} {
  const apiLane: RegisteredFlow[] = [];
  const sandboxLane: RegisteredFlow[] = [];
  for (const flow of flows) {
    if (flow.meta.requires?.includes('daytona')) sandboxLane.push(flow);
    else apiLane.push(flow);
  }
  return { apiLane, sandboxLane };
}

export interface ConcurrentLane {
  flows: RegisteredFlow[];
  workers: number;
}

export interface LaneSchedule {
  /** Lanes that run at the same time as each other, each with its own worker count. */
  concurrent: ConcurrentLane[];
  /** `meta.serial` flows: never beside each other, but free to overlap `concurrent`. */
  serial: RegisteredFlow[];
  /** `meta.global` flows: nothing else may run. Drained last, one at a time. */
  global: RegisteredFlow[];
}

/**
 * Execute a lane schedule.
 *
 * The serial lane joins the same `Promise.all` as the parallel lanes at
 * concurrency 1. `meta.serial` means "does not share state with its peers",
 * not "must be the only thing running", so overlapping it with the parallel
 * lanes removes the ~30-45 min sequential tail without changing what any flow
 * observes: a serial flow still never runs beside another serial flow.
 *
 * The global lane stays strictly last and strictly sequential. All three
 * global flows genuinely require an otherwise-idle deployment:
 *   BILL-13  POST /v1/billing/cron/free-tier-rotation — writes every account
 *   ADM-19   POST /v1/billing/cron/trial-expiry       — writes every account
 *   CONN-5   mutates kortix.yaml on the SHARED managed repo other flows read
 * Overlapping any of them would race flows they do not own.
 *
 * Result order within the returned array is not significant — the caller sorts
 * by flow id and `summarize` counts are order-independent.
 */
export async function runScheduled<R>(
  schedule: LaneSchedule,
  run: (flow: RegisteredFlow) => Promise<R>,
): Promise<R[]> {
  const overlapped = await Promise.all([
    ...schedule.concurrent.map((lane) => mapWithConcurrency(lane.flows, lane.workers, run)),
    mapWithConcurrency(schedule.serial, 1, run),
  ]);
  const out: R[] = overlapped.flat();
  for (const flow of schedule.global) out.push(await run(flow));
  return out;
}
