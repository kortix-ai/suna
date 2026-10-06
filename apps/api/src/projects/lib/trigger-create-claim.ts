/**
 * One creator per trigger key at a time.
 *
 * A keyed or `reuse` trigger looks for its session, finds none, and creates
 * one. Two deliveries inside the create latency both find none and both create:
 * two sandboxes for one chat, and the older one is orphaned. Deliveries with
 * different event ids share no idempotency key, so a claim row in
 * `chat_event_dedup` (the single-winner table the chat channels use) decides
 * who creates. The loser waits for the winner's session and prompts it.
 *
 * A DB error fails open: a rare duplicate beats a dropped message.
 */
import { chatEventDedup } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

/** The create is bounded by the session boot deadline; past this the claim frees itself. */
const CLAIM_TTL_MS = 2 * 60_000;

const claimKey = (key: string) => `trigger-create:${key}`;

/** True when this delivery now owns the create for `key`. */
export async function claimTriggerCreate(key: string): Promise<boolean> {
  try {
    const rows = await db
      .insert(chatEventDedup)
      .values({ eventId: claimKey(key), expiresAt: new Date(Date.now() + CLAIM_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    if (rows.length > 0) return true;
    // A held claim whose creator died: take it over once it has expired.
    const [held] = await db
      .select({ expiresAt: chatEventDedup.expiresAt })
      .from(chatEventDedup)
      .where(eq(chatEventDedup.eventId, claimKey(key)))
      .limit(1);
    if (held && held.expiresAt.getTime() <= Date.now()) {
      await releaseTriggerCreate(key);
      return claimTriggerCreate(key);
    }
    return false;
  } catch (error) {
    console.warn('[trigger-create-claim] claim failed (fail-open)', error);
    return true;
  }
}

export async function releaseTriggerCreate(key: string): Promise<void> {
  try {
    await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claimKey(key)));
  } catch (error) {
    console.warn('[trigger-create-claim] release failed (expires on its own)', error);
  }
}

/** The claim key for a trigger delivery, or null when the trigger creates a session per fire. */
export function triggerCreateKey(input: {
  projectId: string;
  slug: string;
  sessionKey: string | null;
  sessionMode: string | undefined;
}): string | null {
  if (input.sessionKey) return `${input.projectId}:${input.slug}:key:${input.sessionKey}`;
  if (input.sessionMode === 'reuse' || input.sessionMode === 'pinned') return `${input.projectId}:${input.slug}:reuse`;
  return null;
}
