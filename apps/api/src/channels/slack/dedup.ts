import { chatEventDedup } from '@kortix/db';
import { db } from '../../shared/db';
import { EVENT_DEDUPE_TTL_MS } from './app';

// Cross-replica dedup. Slack can redeliver the same event_id (retries); with >1
// API replica an in-memory set only dedups within one process, so a redelivery
// to another replica re-fires the turn. An INSERT … ON CONFLICT DO NOTHING makes
// "already handled?" one shared decision: a row came back ⇒ we're the first to
// claim it; empty ⇒ someone already has.
export async function alreadyHandled(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return false;
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length === 0;
  } catch (err) {
    // Never let a dedup hiccup wedge the webhook — fail open (process the event).
    console.warn('[slack-webhook] event dedup check failed', err);
    return false;
  }
}
