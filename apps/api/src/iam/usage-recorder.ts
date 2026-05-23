// Lazy, throttled recorder for permission-usage analytics. Every allow
// the engine emits goes through `recordAllow()`; this module batches the
// writes in-memory and flushes to iam_action_usage at most every
// FLUSH_INTERVAL_MS or when the in-memory buffer exceeds BUFFER_SOFT_MAX.
//
// Single global aggregator per Node process — fine for our scale, and
// keeps the hot path allocation-free.

import { sql } from 'drizzle-orm';
import { iamActionUsage } from '@kortix/db';
import { db } from '../shared/db';

const FLUSH_INTERVAL_MS = 30_000;
const BUFFER_SOFT_MAX = 500;

type PrincipalKind = 'user' | 'token';

type BufferKey = string; // accountId|principalKind|principalId|action

interface BufferEntry {
  accountId: string;
  principalKind: PrincipalKind;
  principalId: string;
  action: string;
  count: number;
  lastUsedAt: Date;
}

const buffer = new Map<BufferKey, BufferEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

/**
 * Record one allowed authorize() call. Cheap — only touches the in-memory
 * buffer. The actual SQL flush happens on a 30s timer (or earlier if the
 * buffer fills up).
 */
export function recordAllow(args: {
  accountId: string;
  principalKind: PrincipalKind;
  principalId: string;
  action: string;
}): void {
  if (!args.accountId || !args.principalId || !args.action) return;
  const key = `${args.accountId}|${args.principalKind}|${args.principalId}|${args.action}`;
  const existing = buffer.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = new Date();
  } else {
    buffer.set(key, {
      accountId: args.accountId,
      principalKind: args.principalKind,
      principalId: args.principalId,
      action: args.action,
      count: 1,
      lastUsedAt: new Date(),
    });
  }
  scheduleFlush();
  if (buffer.size >= BUFFER_SOFT_MAX) {
    // Buffer hot — flush eagerly. The timer is still useful for
    // low-traffic periods.
    void flushNow();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_INTERVAL_MS);
  // Allow the Node process to exit even if the timer is pending —
  // important under bun test where leaked timers would hang.
  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
    (flushTimer as { unref(): void }).unref();
  }
}

/**
 * Drain the in-memory buffer to the DB in one batched UPSERT. Safe to
 * call concurrently — the `flushing` guard collapses overlapping calls.
 * Exported for tests and graceful shutdown.
 */
export async function flushNow(): Promise<{ rowsWritten: number }> {
  if (flushing) return { rowsWritten: 0 };
  if (buffer.size === 0) return { rowsWritten: 0 };
  flushing = true;
  const snapshot = Array.from(buffer.values());
  buffer.clear();
  try {
    // ON CONFLICT updates: bump call_count by the new delta and bump
    // last_used_at to the most recent observation. first_used_at stays
    // pinned to its original value.
    await db
      .insert(iamActionUsage)
      .values(
        snapshot.map((e) => ({
          accountId: e.accountId,
          principalKind: e.principalKind,
          principalId: e.principalId,
          action: e.action,
          callCount: e.count,
          firstUsedAt: e.lastUsedAt,
          lastUsedAt: e.lastUsedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          iamActionUsage.accountId,
          iamActionUsage.principalKind,
          iamActionUsage.principalId,
          iamActionUsage.action,
        ],
        set: {
          callCount: sql`${iamActionUsage.callCount} + EXCLUDED.${sql.raw('call_count')}`,
          lastUsedAt: sql`GREATEST(${iamActionUsage.lastUsedAt}, EXCLUDED.${sql.raw('last_used_at')})`,
        },
      });
    return { rowsWritten: snapshot.length };
  } catch (err) {
    // Don't let analytics writes break authorise(). Re-buffer the
    // entries so the next flush has a shot — bounded by BUFFER_SOFT_MAX.
    console.warn('[iam-usage] flush failed; re-buffering', err);
    for (const e of snapshot) {
      const key = `${e.accountId}|${e.principalKind}|${e.principalId}|${e.action}`;
      const existing = buffer.get(key);
      if (existing) {
        existing.count += e.count;
        existing.lastUsedAt = e.lastUsedAt > existing.lastUsedAt ? e.lastUsedAt : existing.lastUsedAt;
      } else {
        buffer.set(key, e);
      }
    }
    return { rowsWritten: 0 };
  } finally {
    flushing = false;
  }
}
