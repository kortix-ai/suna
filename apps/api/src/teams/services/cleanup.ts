/**
 * Background cleanup for team state. Currently just expired invites — when
 * more janitorial jobs appear (stale sandbox_members for deleted users, etc.)
 * they belong here next to this one.
 */

import type { Database } from '@kortix/db';
import { deleteExpiredInvites } from '../repositories/invites';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30 * 1000; // let the API finish booting first

let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(db: Database): Promise<void> {
  try {
    const removed = await deleteExpiredInvites(db);
    if (removed > 0) {
      console.log(`[teams/cleanup] Removed ${removed} expired invite(s)`);
    }
  } catch (err) {
    console.warn('[teams/cleanup] Failed to clean expired invites:', (err as Error).message);
  }
}

/**
 * Start the periodic cleanup. Idempotent — calling twice is a no-op. The API
 * should call this once at startup.
 */
export function startInviteCleanup(db: Database): void {
  if (timer) return;

  // First sweep happens after a short delay so we don't race startup, then
  // every CLEANUP_INTERVAL_MS afterwards.
  setTimeout(() => void runOnce(db), STARTUP_DELAY_MS);
  timer = setInterval(() => void runOnce(db), CLEANUP_INTERVAL_MS);
}

export function stopInviteCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
