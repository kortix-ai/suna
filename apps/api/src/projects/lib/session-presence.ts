/**
 * A visible browser tab's presence lease, renewed by its session stream (R5.3).
 *
 * `PUT .../presence` creates the lease when a tab becomes visible and deletes
 * it when the tab hides. Before R5 the tab also PUT every 30 s to keep it; now
 * the tab's `GET .../events?tab_id=` stream renews it on open and every
 * {@link PRESENCE_RENEW_MS} while it stays open, so an idle visible tab sends
 * nothing but the stream. A hidden tab has no lease, so its stream renews
 * nothing and the box sleeps as before.
 */
import { sessionPresenceLeases } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { extendSandboxDeadline, previewGrantMs } from '../sandbox-deadline';

/** How long one lease lives without a renewal. Same as `PUT .../presence`. */
export const PRESENCE_LEASE_MS = 90_000;
/** How often an open stream renews its tab's lease. */
export const PRESENCE_RENEW_MS = 30_000;

/**
 * Extend the lease of one (user, session, tab), and the box deadline with it.
 * Only a lease the tab created exists to renew; a hidden tab's was deleted.
 */
export async function renewSessionPresence(userId: string, sessionId: string, tabId: string): Promise<boolean> {
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
  await extendSandboxDeadline({ sessionId }, previewGrantMs());
  return true;
}
