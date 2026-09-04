/**
 * The scheduled half of blob reclamation.
 *
 * `gc.ts` decides WHICH blobs are collectable; this decides WHEN. Separated
 * because the decision is the part that, wrong, destroys data, and it is worth
 * testing without a clock or a database.
 *
 * LEADER-GATED. It is registered with the singleton workers in `index.ts`, so
 * exactly one replica sweeps at a time. Two replicas sweeping concurrently
 * would both be correct — the delete re-checks the reference — but they would
 * duplicate the object-store round trips for nothing.
 *
 * Cadence: hourly, matching the grace period. A shorter tick cannot reclaim
 * anything a longer one would not: nothing younger than the grace period is
 * eligible, so sweeping every minute would just scan the same rows sixty times.
 */
import { DEFAULT_BLOB_GRACE_MS, sweepUnreferencedBlobs, type BlobSweepResult } from './gc';

const TICK_MS = 60 * 60 * 1000;

type SweepFn = () => Promise<BlobSweepResult>;

let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Armed SYNCHRONOUSLY, unlike `timer`.
 *
 * `timer` is only assigned after the first tick settles, so guarding on it
 * alone let three `start()` calls in the same turn each launch a chain — and
 * `timer` then tracked only the last, leaving the others running forever with
 * no handle to stop them. A leadership flap calls start repeatedly, so this is
 * the ordinary case, not an edge one.
 */
let armed = false;
let stopped = false;
/**
 * Which chain is allowed to keep running.
 *
 * `stopped` alone is not enough: a chain sitting in `await sweep()` when stop()
 * fires will resume LATER, and if start() has run in between it sees
 * `stopped === false` again and re-arms — a zombie from the previous term,
 * ticking beside the new one and sharing its module-level `sweep`. Each start
 * takes a new generation, and a chain exits the moment its own generation is
 * no longer current.
 */
let generation = 0;
let intervalMs = TICK_MS;
let sweep: SweepFn = () => sweepUnreferencedBlobs();

export interface BlobSweeperOptions {
  intervalMs?: number;
  /** Injected by tests; production uses the real sweep. */
  sweep?: SweepFn;
}

export function startFilesystemBlobSweeper(options?: BlobSweeperOptions): void {
  // Idempotent: leadership can flap, and arming a second chain would put two
  // overlapping schedules in one process with only one stop handle.
  if (armed) return;
  armed = true;
  stopped = false;
  generation += 1;
  intervalMs = options?.intervalMs ?? TICK_MS;
  sweep = options?.sweep ?? (() => sweepUnreferencedBlobs());
  // Fire once on boot so blobs orphaned during downtime are not held for a
  // whole tick. The grace period still protects anything mid-write.
  void tickAndRearm(generation);
}

export function stopFilesystemBlobSweeper(): void {
  stopped = true;
  armed = false;
  // Retire this term: any chain still awaiting a sweep exits when it resumes,
  // even if start() runs before then.
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function tickAndRearm(mine: number): Promise<void> {
  if (mine !== generation || stopped) return;
  try {
    const result = await sweep();
    // Only speak when something happened. A quiet sweep every hour on every
    // deployment is log noise that hides the runs that matter.
    if (result.collected > 0 || result.failed > 0) {
      console.log(
        `[filesystem blob sweeper] scanned=${result.scanned} collected=${result.collected} failed=${result.failed}`,
      );
    }
  } catch (err) {
    // A transient database or object-store blip must not disable reclamation
    // until the next restart — re-arm and try again next tick.
    console.error('[filesystem blob sweeper] tick failed', err);
  }
  if (stopped || mine !== generation) return;
  // Re-arm AFTER settling, not on a fixed interval: a sweep slower than the
  // tick would otherwise start again before the previous one finished.
  timer = setTimeout(() => void tickAndRearm(mine), intervalMs);
}

/** Exposed so the cadence and the grace period cannot drift apart unnoticed. */
export const BLOB_SWEEP_TICK_MS = TICK_MS;
export { DEFAULT_BLOB_GRACE_MS };
