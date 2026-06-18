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
import { logger } from '../lib/logger';

const PREFIX = 'kortix-';
const MAX_AGE_MS = 30 * 60 * 1000; // older than this ⇒ abandoned
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function sweepOnce(): Promise<void> {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  let reclaimed = 0;
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (now - s.mtimeMs < MAX_AGE_MS) continue; // leave in-flight contexts alone
      await rm(path, { recursive: true, force: true });
      reclaimed++;
    } catch {
      // racing build, already gone, or perms — skip, retry next sweep
    }
  }
  if (reclaimed > 0) {
    logger.info('[tmp-reaper] reclaimed stale build contexts', { count: reclaimed });
  }
}

export function startTmpReaper(): void {
  if (timer) return;
  void sweepOnce();
  timer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  // Don't keep the process alive for the reaper.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopTmpReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
