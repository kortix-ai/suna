/**
 * A visible browser tab's presence lease, renewed by its session stream (R5.3).
 *
 * `PUT .../presence` creates the lease when a tab becomes visible and deletes
 * it when the tab hides. Before R5 the tab also PUT every 30 s to keep it; now
 * the tab's `GET .../events?tab_id=` stream renews it on open and every
 * {@link PRESENCE_RENEW_MS} while it stays open. A hidden tab has no lease, so
 * its stream renews nothing and the box sleeps as before.
 *
 * KRTX-1729: the lease means a PERSON, not an open tab. The SDK deletes it
 * after 10 min without input (`human-presence.ts`). A renewal extends the
 * box by the idle grace, not the 30-min preview grant, and only for a caller
 * who may start the session; a read-only viewer keeps only the lease, which
 * routes push notifications.
 */
import { sessionPresenceLeases } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { extendSandboxDeadline, idleGraceMs } from '../sandbox-deadline';

/** How long one lease lives without a renewal. Same as `PUT .../presence`. */
export const PRESENCE_LEASE_MS = 90_000;
/** How often an open stream renews its tab's lease. */
export const PRESENCE_RENEW_MS = 30_000;

/**
 * Extend the lease of one (user, session, tab), and, with `extendDeadline`,
 * the box deadline by the idle grace. Only a lease the tab created exists to
 * renew; a hidden or idle tab's was deleted.
 */
export async function renewSessionPresence(
  userId: string,
  sessionId: string,
  tabId: string,
  opts: { extendDeadline: boolean },
): Promise<boolean> {
  const renewed = await db
    .update(sessionPresenceLeases)
    .set({ expiresAt: new Date(Date.now() + PRESENCE_LEASE_MS) })
    .where(
      and(
        eq(sessionPresenceLeases.userId, userId),
        eq(sessionPresenceLeases.sessionId, sessionId),
        eq(sessionPresenceLeases.tabId, tabId),
      ),
    )
    .returning({ tabId: sessionPresenceLeases.tabId });
  if (renewed.length === 0) return false;
  if (opts.extendDeadline) await extendSandboxDeadline({ sessionId }, idleGraceMs());
  return true;
}
