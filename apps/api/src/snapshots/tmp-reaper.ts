// Reaper for stale snapshot/build temp dirs.
//
// build-context.ts, warm-bake.ts, and the various CLI/e2e helpers all stage work
// into mkdtemp(tmpdir(), 'kortix-…-') dirs and hand cleanup back to the caller.
// Any error path or missed cleanup() leaks a dir full of staged binaries/tarballs
// into the container's writable layer — which is node ephemeral storage. Over
// many session-boot/bake builds these accumulate to GBs (observed ~20GB/pod),
// fill the node disk, and trip kubelet DiskPressure → pods get evicted cluster-
// wide. quota-gc.ts only reaps Daytona-side warm snapshots, not these local dirs.
//
// This sweep runs on EVERY replica (build contexts are created on any pod during
// on-demand session boot, not just the leader) and removes kortix-* temp dirs
// whose mtime is older than MAX_AGE — long past the seconds-to-minutes a context
// is actually needed, so in-flight builds are never touched.

import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Fiber, Schedule } from 'effect';
import { logger } from '../lib/logger';

const PREFIX = 'kortix-';
const MAX_AGE_MS = 30 * 60 * 1000; // older than this ⇒ abandoned
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let reaperFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;

const reaperSchedule = Schedule.spaced(`${SWEEP_INTERVAL_MS} millis`);

const sweepOnceEffect = Effect.gen(function* () {
  const dir = tmpdir();
  const entries = yield* Effect.tryPromise({
    try: () => readdir(dir),
    catch: () => null,
  });
  if (!entries) return;

  const now = Date.now();
  let reclaimed = 0;
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    yield* Effect.gen(function* () {
      const s = yield* Effect.tryPromise(() => stat(path));
      if (now - s.mtimeMs >= MAX_AGE_MS) {
        yield* Effect.tryPromise(() => rm(path, { recursive: true, force: true }));
        reclaimed++;
      }
    }).pipe(Effect.catchAll(() => Effect.void));
  }

  if (reclaimed > 0) {
    yield* Effect.sync(() =>
      logger.info('[tmp-reaper] reclaimed stale build contexts', { count: reclaimed }),
    );
  }
});

const tmpReaperProgram = Effect.repeat(sweepOnceEffect, reaperSchedule);

const tmpReaperScoped = Effect.gen(function* () {
  yield* Effect.acquireRelease(
    Effect.sync(() => Effect.runFork(tmpReaperProgram)),
    (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
  );
  return yield* Effect.never;
});

export function startTmpReaper(): void {
  if (reaperFiber) return;
  reaperFiber = Effect.runFork(Effect.scoped(tmpReaperScoped));
}

export function stopTmpReaper(): void {
  if (reaperFiber) {
    Effect.runFork(Fiber.interrupt(reaperFiber));
    reaperFiber = null;
  }
}
