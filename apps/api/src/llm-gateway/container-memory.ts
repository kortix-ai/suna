/**
 * Size the gateway's in-flight budget from the memory the process ACTUALLY has.
 *
 * WHY THIS EXISTS, and why a constant will not do.
 *
 * A self-host `docker-compose.yml` is rendered ONCE, at install. `updater.sh`
 * pulls images and recreates containers against that already-rendered file and
 * never regenerates it — its own comment says the replica count "is decided
 * once, at render time... We just read it back". So every change to `MEM_LIMITS`
 * in compose-assets.ts reaches only boxes rendered after it.
 *
 * Measured consequence, 2026-08-21: a box rendered while `llm-gateway` was a
 * literal `512m` still had 512m months later, straight through the update that
 * raised the code default to 2048m — the fix shipped and could not land.
 * `kortix-api` escaped the same fate only by accident, because it happened to be
 * written as `${KORTIX_API_MEMORY_LIMIT:-640m}` and could be moved from `.env`.
 *
 * A hardcoded budget default inherits exactly that problem one layer down: 512
 * MiB is prudent in a 4 GiB task and is 80% of everything the process owns in a
 * 640 MiB container. So the number is not written down anywhere. The process
 * reads its own cgroup limit at boot and takes a fraction of it, which means:
 *
 *   - it is correct on a 640m box, a 2 GiB box and a 16 GiB box, with no config;
 *   - a stale rendered compose file becomes harmless, because the process reads
 *     REALITY rather than a file somebody forgot to regenerate;
 *   - raising a container's memory raises its throughput automatically. That is
 *     vertical scaling with nothing to remember.
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const MiB = 1024 * 1024;

/** cgroup v2 first, then v1. Both are plain files holding a byte count. */
const CGROUP_V2 = '/sys/fs/cgroup/memory.max';
const CGROUP_V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/**
 * Anything at or above this is a "no limit" sentinel, not a real ceiling.
 * cgroup v1 writes a value near 2^63 when unconstrained; v2 writes "max".
 */
const UNLIMITED_SENTINEL = 2 ** 53;

/** Fraction of container memory the gateway may hold in request bodies. */
export const INFLIGHT_BUDGET_FRACTION = 0.25;

/** Used only when the limit cannot be determined at all. */
const FALLBACK_BUDGET_BYTES = 256 * MiB;

/** Small enough to matter, large enough to still admit ordinary traffic. */
const MINIMUM_BUDGET_BYTES = 16 * MiB;

export interface MemoryProbe {
  /** Returns file contents, or null when the path does not exist. */
  read: (path: string) => string | null;
  totalMemory: () => number;
}

const defaultProbe: MemoryProbe = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  totalMemory: () => totalmem(),
};

/**
 * The memory ceiling this process is really subject to, or host memory when it
 * is unconstrained. Never throws: a probe failure degrades to host memory.
 */
export function detectContainerMemoryLimitBytes(probe: MemoryProbe = defaultProbe): number | null {
  let host: number | null = null;
  try {
    const total = probe.totalMemory();
    if (Number.isFinite(total) && total > 0) host = total;
  } catch {
    host = null;
  }

  for (const path of [CGROUP_V2, CGROUP_V1]) {
    let raw: string | null = null;
    try {
      raw = probe.read(path);
    } catch {
      // A cgroup file that cannot be read tells us nothing; fall through to the
      // next candidate rather than failing the boot.
      continue;
    }
    if (!raw) continue;
    const text = raw.trim();
    if (!text || text === 'max') continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value >= UNLIMITED_SENTINEL) continue;
    // A cgroup ceiling above host memory is not a ceiling the machine can honour.
    return host !== null ? Math.min(value, host) : value;
  }

  return host;
}

/**
 * Budget for `InflightBudget.maxBytes`, in AMPLIFIED bytes — the same unit that
 * class compares against, i.e. an estimate of real memory rather than wire bytes.
 */
export function deriveInflightBudgetBytes(limitBytes: number | null): number {
  if (limitBytes === null || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return FALLBACK_BUDGET_BYTES;
  }
  return Math.max(MINIMUM_BUDGET_BYTES, Math.floor(limitBytes * INFLIGHT_BUDGET_FRACTION));
}
