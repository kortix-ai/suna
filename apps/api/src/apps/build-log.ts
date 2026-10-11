/**
 * Build output → `build_log` deployment events, batched and bounded.
 *
 * The worker used to insert one row per build line, fire-and-forget: a noisy
 * npm or Docker build made 10^4-10^5 inserts with no backpressure. Now:
 *
 *   - lines are buffered and written as one multi-row insert every
 *     `FLUSH_EVERY_MS` or every `FLUSH_LINES` lines, one insert at a time;
 *   - a deployment keeps the first `HEAD_LINES` and the last `TAIL_LINES`.
 *     The head is written as it arrives. The tail is held in memory and
 *     written by `close()`, after a `log_truncated` event that says how many
 *     lines in between were dropped.
 */

import { appDeploymentEvents } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';

export const BUILD_LOG_LIMITS = {
  HEAD_LINES: 2_500,
  TAIL_LINES: 2_500,
  FLUSH_LINES: 200,
  FLUSH_EVERY_MS: 1_000,
  LINE_CHARS: 4_000,
} as const;

export interface BuildLogRow {
  type: 'build_log' | 'log_truncated';
  message: string;
  data?: Record<string, unknown>;
}

export type BuildLogInsert = (rows: BuildLogRow[]) => Promise<void>;

/** One statement per batch. Each row gets now() plus its index in µs, so a batch reads back in order. */
function insertBuildLogRows(deploymentId: string): BuildLogInsert {
  return async (rows) => {
    await db.insert(appDeploymentEvents).values(rows.map((row, index) => ({
      deploymentId,
      level: row.type === 'build_log' ? 'debug' as const : 'warn' as const,
      type: row.type,
      message: row.message,
      data: row.data ?? {},
      createdAt: sql`now() + ${index} * interval '1 microsecond'` as unknown as Date,
    })));
  };
}

export interface BuildLog {
  line(text: string): void;
  /** Writes what is buffered and the held tail. Never throws. */
  close(): Promise<void>;
}

export function createBuildLog(
  deploymentId: string,
  insert: BuildLogInsert = insertBuildLogRows(deploymentId),
): BuildLog {
  const limits = BUILD_LOG_LIMITS;
  const pending: BuildLogRow[] = [];
  let headWritten = 0;
  const tail: string[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (rows: BuildLogRow[]) => {
    chain = chain.then(() => insert(rows)).catch((error) => {
      logger.warn('[apps] build log batch was not written', {
        deploymentId,
        lines: rows.length,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const dropTailOverflow = () => {
    const overflow = Math.max(0, tail.length - limits.TAIL_LINES);
    tail.splice(0, overflow);
    dropped += overflow;
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.length > 0) enqueue(pending.splice(0));
  };

  return {
    line(text) {
      const message = text.slice(0, limits.LINE_CHARS);
      if (headWritten < limits.HEAD_LINES) {
        headWritten += 1;
        pending.push({ type: 'build_log', message });
        if (pending.length >= limits.FLUSH_LINES) flush();
        else timer ??= setTimeout(flush, limits.FLUSH_EVERY_MS);
        return;
      }
      tail.push(message);
      // Trim in chunks: one splice per TAIL_LINES lines instead of a shift per line.
      if (tail.length >= 2 * limits.TAIL_LINES) dropTailOverflow();
    },
    async close() {
      dropTailOverflow();
      if (dropped > 0) {
        pending.push({
          type: 'log_truncated',
          message: `Build log truncated: ${dropped} lines dropped between the first ${limits.HEAD_LINES} and the last ${limits.TAIL_LINES}`,
          data: { dropped, head: limits.HEAD_LINES, tail: limits.TAIL_LINES },
        });
      }
      if (timer) clearTimeout(timer);
      timer = null;
      const rows = [...pending.splice(0), ...tail.splice(0).map((message) => ({ type: 'build_log' as const, message }))];
      for (let start = 0; start < rows.length; start += limits.FLUSH_LINES) {
        enqueue(rows.slice(start, start + limits.FLUSH_LINES));
      }
      await chain;
    },
  };
}
