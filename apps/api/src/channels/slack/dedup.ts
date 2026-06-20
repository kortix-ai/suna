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

// ── Exactly-once gate for an inbound user MESSAGE ────────────────────────────
// `alreadyHandled` dedups the event ENVELOPE (event_id), but ONE user message can
// reach us as several envelopes with DIFFERENT event_ids — Slack delivers a
// channel @mention as both an `app_mention` AND a `message`, and redeliveries can
// arrive on different replicas. Every one of them, however, carries the SAME
// message coordinates `(team, channel, ts)`. Claiming THAT identity once — via the
// same pooler-safe INSERT … ON CONFLICT on the shared dedup table — guarantees a
// single agent run per message no matter the delivery path (retry, fan-out,
// concurrent replicas). This is the keystone that makes the turn flow idempotent:
// without it, a redelivery that lands after the thread→session mapping exists is
// treated as a brand-new follow-up and runs the agent a second time.
export function inboundMessageKey(
  teamId: string,
  event: { channel?: string; ts?: string },
): string | null {
  if (!teamId || !event.channel || !event.ts) return null;
  return `slack:msg:${teamId}:${event.channel}:${event.ts}`;
}

// Returns true iff WE are the first to claim this message → run it. Empty ⇒ a
// retry / fan-out / sibling replica already owns it → must NOT run again.
// Fail-OPEN on a DB error (mirrors `alreadyHandled`/`claimThreadCreate`): the
// atomic INSERT is what guarantees exactly-once under healthy operation — the
// entire incident class — and we'd rather risk a rare duplicate during a DB
// outage than silently drop a user's message. Errors are logged loudly.
export async function claimInboundMessage(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.error('[slack-webhook] inbound message claim failed (fail-open)', err);
    return true;
  }
}
