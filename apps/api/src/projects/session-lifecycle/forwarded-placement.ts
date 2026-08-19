/**
 * Placing a forwarded prompt INTO a live OpenCode turn, and proving it landed.
 *
 * OpenCode's loop decides "is the latest user message answered?" by ID ORDER:
 * at the top of every step it exits when `lastUser.id < lastAssistant.id` and
 * that assistant finished without tool calls. A user message whose id sorts
 * below an assistant message that was created BEFORE it was inserted is
 * therefore read as history the moment the running step ends — the model
 * never sees it and nothing ever answers it. The prompt is STRANDED: persisted,
 * visible in the transcript, silently dropped.
 *
 * The drain re-mints a mid-turn prompt above the transcript's newest id, but
 * "newest" is read BEFORE the POST. The box keeps minting ids on its own clock
 * in between (every step opens a new assistant message), so a read→insert
 * window of a few hundred milliseconds loses a prompt whenever a step boundary
 * falls inside it. Measured locally: 1 of 3 queued prompts (`queue-lab`,
 * 2026-08-19).
 *
 * Two layers close that window, both server-side:
 *
 *  1. PLACEMENT — `mintLivePlacement`: place the prompt at the BOX's clock
 *     "now", not at newest+1. The box clock is learned from the box itself:
 *     every message we insert comes back with `time.created` stamped by the
 *     box, and we know when our POST was acknowledged, so
 *     `created − ackAt` is a lower bound on (box − api) skew (the box stamped
 *     it before we saw the ack). Lower bound on purpose: an id that lands a
 *     little LOW can only be stranded, which layer 2 repairs; an id that lands
 *     HIGH (above the assistant that will answer it) makes OpenCode run the
 *     step twice — a duplicate answer nothing can take back.
 *
 *  2. PROOF — `strandedPlacement`: after the insert, one tip read answers
 *     "did this land above every assistant that predates it?" exactly. An
 *     assistant with a higher id whose parent is an OLDER user message was
 *     created by a step that never read this prompt. When it is there, the
 *     drain deletes the stranded message and delivers again, above it. The
 *     same predicate runs at turn end for every still-open forwarded prompt
 *     (`routes/r4.ts` `turn-stream` `end`) — the safety net for a verify read
 *     that failed.
 *
 * Pure over its inputs so the golden cases are assertable without a box.
 */

import {
  MAX_WIRE_ID_CLOCK_CORRECTION,
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  mintWireMessageId,
  newestWireIdTime,
  wireIdTime,
} from '../wire-message-id';

/** The shape of one transcript message the placement logic reads. */
export interface PlacementTipMessage {
  id: string;
  role: string;
  parentID?: string | null;
  created?: number | null;
  /** `time.completed` — null/absent while an assistant message is still open. */
  completed?: number | null;
  /** Ids of the message's parts. A USER message with zero parts is a husk a
   *  cancel left behind (the model never sees it) — see the reconcile sweep. */
  partIds?: string[];
}

export interface PlacementVerdict {
  /** An assistant message is parented on this wire id — the turn ran. */
  answered: boolean;
  /** The strand signature: an assistant with a HIGHER id whose parent is an
   *  OLDER user message — a step that never read this prompt finished after
   *  it landed. Never true when `answered`. */
  stranded: boolean;
  /** The id of the newest assistant that proves the strand, for the log. */
  strandedBy: string | null;
  /** Highest id clock on the tip, for placing the next mint above it. */
  newest: bigint | null;
  /** The box's `time.created` for this wire id, when the tip holds it. */
  createdMs: number | null;
}

/**
 * Is this forwarded prompt answered, stranded, or still in line?
 *
 *  - answered: some assistant's `parentID` is this id.
 *  - stranded: no assistant answers it, and some assistant has a higher id
 *    AND a parent that sorts BELOW this id. That assistant's step read the
 *    transcript before this prompt existed; the loop's exit check sorts this
 *    prompt under it and never runs it. An assistant with a higher id whose
 *    parent is this id or a NEWER user message read the prompt (OpenCode
 *    parents each step on the newest user message and answers everything
 *    before it in that step) — that is "in line", not stranded.
 *  - otherwise: not reached yet.
 *
 * An assistant with no readable parent proves nothing either way.
 */
export function strandedPlacement(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): PlacementVerdict {
  const mine = wireIdTime(wireMessageId);
  const newest = newestWireIdTime(tip.map((m) => m.id));
  const own = tip.find((m) => m.id === wireMessageId);
  const createdMs = typeof own?.created === 'number' && Number.isFinite(own.created) ? own.created : null;
  let answered = false;
  let strandedBy: string | null = null;
  if (mine !== null) {
    for (const m of tip) {
      if (m.role !== 'assistant') continue;
      if (m.parentID === wireMessageId) {
        answered = true;
        break;
      }
      const at = wireIdTime(m.id);
      const parentAt = typeof m.parentID === 'string' ? wireIdTime(m.parentID) : null;
      if (at === null || parentAt === null) continue;
      if (at > mine && parentAt < mine) strandedBy = m.id;
    }
  }
  return {
    answered,
    stranded: !answered && strandedBy !== null,
    strandedBy: answered ? null : strandedBy,
    newest,
    createdMs,
  };
}

/**
 * Has the loop REACHED this user message — read it into a step? True when an
 * assistant answers it, or when an assistant with a higher id is parented on
 * it or on a NEWER user message (that step's read included it). A message the
 * loop has not reached is still just text in the transcript: it can be taken
 * back out without the model ever having seen it.
 */
export function reachedPlacement(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): boolean {
  const mine = wireIdTime(wireMessageId);
  if (mine === null) return false;
  const own = tip.find((m) => m.id === wireMessageId);
  for (const m of tip) {
    if (m.role !== 'assistant') continue;
    if (m.parentID === wireMessageId) return true;
    const at = wireIdTime(m.id);
    const parentAt = typeof m.parentID === 'string' ? wireIdTime(m.parentID) : null;
    if (at === null || parentAt === null || at <= mine || parentAt < mine) continue;
    // ID order says this step covers the message — but ids are minted from
    // the SENDER's clock, not from causality: a message deliberately placed
    // BELOW the running step's parent (under-placement) has a lower id than
    // an assistant whose step began before it even arrived. `time.created`
    // is stamped at PERSISTENCE by the box, on one clock — when both stamps
    // exist, a step only read this message if it STARTED after the message
    // was persisted.
    if (
      typeof own?.created === 'number' &&
      typeof m.created === 'number' &&
      m.created <= own.created
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Is there an OPEN user message ABOVE this id — placed (not stranded),
 * unanswered? Then a message that sits BELOW it is not lost: OpenCode's next
 * step parents on the newest user message and hands the model the whole
 * transcript, so everything under it is answered in that step. This is what
 * lets a late delivery keep its ORIGINAL (send-ordered) id instead of
 * re-minting to the top, and what lets the reconciler leave a stranded row
 * alone.
 */
export function openUserAbove(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): boolean {
  const mine = wireIdTime(wireMessageId);
  if (mine === null) return false;
  for (const m of tip) {
    if (m.role !== 'user' || m.id === wireMessageId) continue;
    const at = wireIdTime(m.id);
    if (at === null || at <= mine) continue;
    const v = strandedPlacement(tip, m.id);
    if (!v.answered && !v.stranded) return true;
  }
  return false;
}

/** Is the box mid-step — its newest assistant message still open? */
export function tipIsBusy(tip: ReadonlyArray<PlacementTipMessage>): boolean {
  let newest: PlacementTipMessage | null = null;
  for (const m of tip) {
    if (m.role !== 'assistant') continue;
    if (!newest || m.id > newest.id) newest = m;
  }
  return !!newest && (newest.completed === null || newest.completed === undefined);
}

/** Parse OpenCode's `GET /session/:id/message` body into tip messages. */
export function parsePlacementTip(body: unknown): PlacementTipMessage[] | null {
  if (!Array.isArray(body)) return null;
  const out: PlacementTipMessage[] = [];
  for (const entry of body) {
    const info = (entry as { info?: Record<string, unknown> } | null)?.info;
    if (!info || typeof info.id !== 'string' || typeof info.role !== 'string') continue;
    const time = info.time as { created?: unknown; completed?: unknown } | undefined;
    out.push({
      id: info.id,
      role: info.role,
      parentID: typeof info.parentID === 'string' ? info.parentID : null,
      created: typeof time?.created === 'number' ? time.created : null,
      completed: typeof time?.completed === 'number' ? time.completed : null,
      partIds: (
        (entry as { parts?: Array<{ id?: unknown }> }).parts ?? []
      ).flatMap((part) => (typeof part?.id === 'string' ? [part.id] : [])),
    });
  }
  return out;
}

// ─── Box clock ───────────────────────────────────────────────────────────────

/**
 * A learned (box − api) clock skew, per session. In-process and bounded: a
 * replica that has not learned a session's skew falls back to newest+1 and the
 * proof layer — correctness never depends on this cache being populated.
 *
 * SHORT-lived on purpose. A sample is only ever taken from a live delivery,
 * and a box that parks and resumes (a snapshot restore) comes back with its
 * guest clock BEHIND by the parked time until NTP steps it — a sample from
 * before the park would then place ids HIGH, the one direction nothing can
 * repair. A box parks only after minutes of idle, so a 2-minute TTL cannot
 * straddle a park; every live delivery re-samples anyway.
 */
const SKEW_TTL_MS = 2 * 60_000;
const SKEW_CACHE_MAX = 5_000;
const skewBySession = new Map<string, { skewMs: number; at: number }>();

/**
 * Record one sample: the box stamped `createdMs` on a message whose POST we
 * saw acknowledged at `ackAtMs` (api clock). The box wrote the stamp before
 * we saw the ack, so `created − ack` never overstates the skew.
 */
export function noteBoxClockSample(
  sessionId: string,
  createdMs: number,
  ackAtMs: number,
  nowMs = Date.now(),
): number {
  const skewMs = createdMs - ackAtMs;
  if (skewBySession.size >= SKEW_CACHE_MAX) {
    const oldest = skewBySession.keys().next().value;
    if (oldest !== undefined) skewBySession.delete(oldest);
  }
  skewBySession.delete(sessionId);
  skewBySession.set(sessionId, { skewMs, at: nowMs });
  return skewMs;
}

/**
 * Chaos knob: `KORTIX_PLACEMENT_LIFT_DISABLED=1` places every live-turn
 * delivery at newest+1 again (the pre-fix behaviour), so the strand path and
 * its turn-end repair can be exercised on demand. Never set in a deployment.
 */
function liftDisabled(): boolean {
  return (process.env.KORTIX_PLACEMENT_LIFT_DISABLED ?? '').trim() === '1';
}

export function boxClockSkewMs(sessionId: string, nowMs = Date.now()): number | null {
  if (liftDisabled()) return null;
  const entry = skewBySession.get(sessionId);
  if (!entry) return null;
  if (nowMs - entry.at > SKEW_TTL_MS) {
    skewBySession.delete(sessionId);
    return null;
  }
  return entry.skewMs;
}

/** Test seam. */
export function resetBoxClockSkewForTests(): void {
  skewBySession.clear();
}

/**
 * A learned skew larger than this is not trusted for placement: it would put
 * the id far from anything the box is writing, which on the high side means a
 * duplicate step. Bounded by the same ceiling the transcript lift accepts.
 */
const MAX_TRUSTED_SKEW_MS = Number(MAX_WIRE_ID_CLOCK_CORRECTION / WIRE_ID_TIME_SCALE);

/**
 * Mint the id a LIVE-turn delivery goes out under.
 *
 * Floor: strictly above `newestKnownTime` (what `remintWireMessageId` always
 * did). Lift: when the box clock is known, up to the box's estimated "now" —
 * where OpenCode itself would have minted the message, which is the one place
 * that is both above every assistant already created and below the one that
 * will answer it. The lift is never applied beyond the trusted-skew ceiling,
 * and never moves the id BELOW the floor.
 */
export function mintLivePlacement(input: {
  nowMs: number;
  newestKnownTime: bigint | null;
  boxSkewMs: number | null;
  random?: () => number;
}): { id: string; time: bigint; lifted: boolean } {
  const base = mintWireMessageId({
    nowMs: input.nowMs,
    newestKnownTime: input.newestKnownTime,
    random: input.random,
  });
  const skew = input.boxSkewMs;
  if (skew === null || !Number.isFinite(skew) || Math.abs(skew) > MAX_TRUSTED_SKEW_MS) {
    return { ...base, lifted: false };
  }
  const boxNow =
    (BigInt(Math.trunc(input.nowMs + skew)) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;
  if (boxNow <= base.time) return { ...base, lifted: false };
  // Never lift past what the floor itself would accept as a correction.
  if (input.newestKnownTime !== null && boxNow - input.newestKnownTime > MAX_WIRE_ID_CLOCK_CORRECTION) {
    return { ...base, lifted: false };
  }
  const tail = base.id.slice('msg_'.length + 12);
  return {
    id: `msg_${boxNow.toString(16).padStart(12, '0')}${tail}`,
    time: boxNow,
    lifted: true,
  };
}
