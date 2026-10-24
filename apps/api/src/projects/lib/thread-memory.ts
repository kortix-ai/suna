/**
 * Room for a conversion thread (a Bun `Worker` that holds a whole session in memory): the
 * session-log backfill's thread (`session-log-backfill.ts`) and the journal-less capture's
 * (`captureInThread`, `session-transcript-capture.ts`) share this one guard.
 */
import { readFileSync } from 'node:fs';
import { config } from '../../config';

/**
 * The thread's peak memory per byte of the session's JSON, rounded up: 11.3 measured with `smol`
 * (1-vCPU Linux container, 131 MB of JSON, ~1.48 GB peak above the process).
 */
export const THREAD_BYTES_PER_JSON_BYTE = 12;
/** The share of the memory limit RSS plus the thread's estimate must stay under. */
const THREAD_MEMORY_SHARE = 0.75;

/** The process's memory limit in bytes: cgroup v2 `memory.max` when set, capped by `SESSION_LOG_BACKFILL_MEMORY_MB`. */
function memoryLimit(): number {
  const configured = config.SESSION_LOG_BACKFILL_MEMORY_MB * 1024 * 1024;
  try {
    const max = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (/^\d+$/.test(max)) return Math.min(Number(max), configured);
  } catch {
    // No cgroup v2 file (macOS, cgroup v1): the configured limit.
  }
  return configured;
}

/** Room for a thread that holds `jsonBytes` of session JSON: RSS plus its estimate under 75 % of the limit. */
export function threadRoom(jsonBytes: number): { fits: boolean; rss: number; need: number; limit: number } {
  const rss = process.memoryUsage().rss;
  const need = jsonBytes * THREAD_BYTES_PER_JSON_BYTE;
  const limit = memoryLimit();
  return { fits: rss + need <= THREAD_MEMORY_SHARE * limit, rss, need, limit };
}
