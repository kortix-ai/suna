/**
 * "A person stopped this session" — the instant, recorded on the session's box
 * row, that every requeue path compares a prompt's delivery against.
 *
 * The Stop's hold (`holdInboxPrompts`) marks the rows it can see: queued,
 * claimed, and FORWARDED. It cannot mark a steer the runtime already ACCEPTED:
 * the acceptance relay closes such a row `delivered` on persistence, long
 * before a step reads it, and a `delivered` row is history to the hold. That
 * steer is still unread when the Stop ends the turn, and two repairs then hand
 * it back to the inbox — the turn-end strand reconcile
 * (`requeueStrandedPrompt`) and the reaper (`requeueAbandonedPrompt`). Due
 * now, either one delivers a prompt behind the user's back, and after
 * `POST .../stop` it wakes the box the user just powered off.
 *
 * So the Stop also writes WHEN it happened, and while that Stop is in force
 * (until the next release: a send, "send now", Resume) a repair of a prompt
 * that went out BEFORE that instant comes back held.
 *
 * The same record orders a SEND against the Stop. The browser POSTs queued
 * sends one after another, so a prompt typed before Stop can reach the server
 * after the hold — and "any new send releases the hold" then released the
 * queue the user had just paused (measured 2026-09-23: the head row was
 * delivered the moment the Stop ended the turn). The browser sends its Stop
 * instant with the hold, and every send carries its Enter instant, on the same
 * clock: a send typed before the Stop joins the hold (`sendJoinsHold`).
 */

import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

const KEY = 'inboxStopRequestedAt';
/** True from a Stop until the next release (send, "send now", Resume). */
const ACTIVE_KEY = 'inboxHoldActive';
/** The Stop instant on the CLIENT's clock, when the client sent one. */
const CLIENT_KEY = 'inboxHoldClientStoppedAtMs';

/**
 * Record that a person stopped this session now. Merged into the box row.
 * `clientStoppedAtMs` is the Stop instant on the browser's clock
 * (`POST .../prompts/hold {stopped_at_ms}`); a server-side hold for the same
 * Stop (the proxy's) carries none and keeps the one already recorded.
 */
export async function markUserStopRequested(
  sessionId: string,
  opts: { clientStoppedAtMs?: number | null } = {},
): Promise<void> {
  const client =
    typeof opts.clientStoppedAtMs === 'number' && Number.isFinite(opts.clientStoppedAtMs)
      ? Math.trunc(opts.clientStoppedAtMs)
      : null;
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`COALESCE(${sessionSandboxes.metadata}, '{}'::jsonb)
        || jsonb_build_object(${KEY}::text, to_jsonb(now()), ${ACTIVE_KEY}::text, true)
        || ${client === null ? sql`'{}'::jsonb` : sql`jsonb_build_object(${CLIENT_KEY}::text, ${client}::bigint)`}`,
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}

/** The hold is over (a release). Repairs deliver again; no send joins it. */
export async function clearUserStop(sessionId: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`(COALESCE(${sessionSandboxes.metadata}, '{}'::jsonb) - ${CLIENT_KEY}::text)
        || jsonb_build_object(${ACTIVE_KEY}::text, false)`,
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}

interface UserStop {
  /** Server instant of the Stop, epoch ms. */
  atMs: number;
  /** Client instant of the Stop, epoch ms on the client's clock, or null. */
  clientAtMs: number | null;
}

/** The Stop currently in force for this session, or null. */
export async function readUserStop(sessionId: string): Promise<UserStop | null> {
  const [box] = await db
    .select({
      at: sql<string | null>`${sessionSandboxes.metadata}->>${KEY}::text`,
      active: sql<string | null>`${sessionSandboxes.metadata}->>${ACTIVE_KEY}::text`,
      client: sql<string | null>`${sessionSandboxes.metadata}->>${CLIENT_KEY}::text`,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!box || box.active !== 'true') return null;
  const atMs = box.at ? Date.parse(box.at) : Number.NaN;
  if (!Number.isFinite(atMs)) return null;
  const clientAtMs = box.client !== null && box.client !== undefined ? Number(box.client) : Number.NaN;
  return { atMs, clientAtMs: Number.isFinite(clientAtMs) ? clientAtMs : null };
}

/** When the Stop in force happened (server clock, epoch ms); null when none. */
export async function readUserStopRequestedAt(sessionId: string): Promise<number | null> {
  return (await readUserStop(sessionId))?.atMs ?? null;
}

/**
 * Did a person stop the session AFTER this prompt went out? `forwardedAt` is
 * the row's `result.forwarded_at`. A row with no delivery instant cannot be
 * shown to predate the Stop, so it is not held by this rule.
 */
export function stoppedAfterDelivery(stopAtMs: number | null, forwardedAt: unknown): boolean {
  if (stopAtMs === null || typeof forwardedAt !== 'string') return false;
  const sentMs = Date.parse(forwardedAt);
  return Number.isFinite(sentMs) && stopAtMs >= sentMs;
}
