/**
 * Placing a forwarded prompt INTO a live OpenCode turn, and proving it landed.
 *
 * HOW THE LOOP DECIDES "is the latest user message answered?" — AND THAT IT
 * DEPENDS ON THE BOX'S OPENCODE VERSION. `opencode` is baked into the sandbox
 * image at build time, so a session's runtime is whatever its image shipped
 * with, and BOTH of these are live in the fleet right now:
 *
 *  - opencode <= 1.18.14 (every box provisioned before 2026-08-20 runs the
 *    baked 1.17.11): ID ORDER. At the top of every step the loop exits when
 *    `lastUser.id < lastAssistant.id` and that assistant finished without tool
 *    calls. A user message whose id sorts below an assistant message created
 *    BEFORE it was inserted is read as history the moment the running step
 *    ends — the model never sees it and nothing answers it. The prompt is
 *    STRANDED: persisted, visible in the transcript, silently dropped. This is
 *    the failure mode everything below exists for.
 *  - opencode >= 1.18.15 (boxes built from the 1.18.19 image): PARENT LINK.
 *    Upstream retired id-ordering as chronology — the exit test is now
 *    `lastAssistant.parentID === lastUser.id`, and `latest()` orders by
 *    `time.created`. A low id no longer strands a prompt on its own.
 *
 * `MessageV2.page()` — the `GET /session/:id/message` read every function here
 * consumes — has ALWAYS ordered by `time_created` (then `id` as the sub-ms
 * tiebreak), in BOTH versions. It is only the LOOP's chronology that changed.
 *
 * The machinery below therefore stays: it is required on old boxes and inert
 * on new ones (a correctly-placed id is correct under either rule). What must
 * NOT persist is code that reads chronology out of a raw string compare on
 * ids — see `isLaterTipMessage`, which is `time.created`-first and falls back
 * to the id clock only when a stamp is missing.
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
 *     it before we saw the ack). Lower bound on purpose, and the asymmetry is
 *     the reason: on an id-ordering box (<= 1.18.14) an id that lands a little
 *     LOW can only be stranded, which layer 2 repairs; an id that lands HIGH
 *     (above the assistant that will answer it) makes OpenCode run the step
 *     twice — a duplicate answer nothing can take back. On a >= 1.18.15 box
 *     neither direction strands, so the lift is inert there; keep the lower
 *     bound because the fleet still contains boxes of the first kind.
 *
 *  2. PROOF — `strandedPlacement`: after the insert, one tip read answers
 *     "did this land above every assistant that predates it?" exactly. An
 *     assistant with a higher id whose parent is an OLDER user message — and
 *     whose `time.created` does not prove its step began AFTER this prompt
 *     was persisted — was created by a step that never read this prompt. When
 *     it is there, the drain deletes the stranded message and delivers again,
 *     above it. The same predicate runs at turn end for every still-open
 *     forwarded prompt (`routes/r4.ts` `turn-stream` `end`) — the safety net
 *     for a verify read that failed.
 *
 * THE STRAND SIGNATURE IS AN ID-ORDER CLAIM, AND ID ORDER IS NOT CHRONOLOGY.
 * A wire id is minted by the SENDER — the client, or this process's placement
 * minter, which deliberately LIFTS a live-turn delivery to the box clock and
 * deliberately UNDER-PLACES a later one below an open sibling. `time.created`
 * is stamped by the box at persistence, on one clock, for every message. So
 * when both stamps exist they settle "was this prompt in that step's input"
 * outright: an assistant whose `time.created` is later than the prompt's was
 * opened by a step that began after the prompt was persisted, and that step
 * read it. Measured 2026-09-21/22, three of three steer runs (sessions
 * 4f345186, 17e3ad83, f0e9b423, 1548cb84): three Quick Queue prompts steered
 * ~1 s apart into a tool turn — the second LIFTED above every sibling, the
 * third UNDER-PLACED at its client id. OpenCode >= 1.18.15 parented the ONE
 * merged reply on the third (newest by `time.created`); by id order that reply
 * sits above the lifted prompt with a parent below it — the strand signature —
 * and the turn-end reconcile deleted the lifted prompt, re-queued it
 * (`redeliveries = 1`), closed its ledger row `abandoned`, and the model
 * answered it a second, paid time. The stamps said "read" the whole time. The
 * id-order verdict is now the FALLBACK, for a stamp that is missing.
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
   *  it landed — and no box stamp says otherwise. Never true when `answered`
   *  and never true when a `readBy` step exists. */
  stranded: boolean;
  /** The id of the newest assistant that proves the strand, for the log. */
  strandedBy: string | null;
  /** An assistant NOT parented on this id whose step provably began AFTER
   *  this message was persisted (`time.created` on both, box clock): this
   *  message was in that step's input and the step read it. Live incident
   *  2026-09-22: the one merged reply of a later, under-placed sibling. The
   *  newest such assistant by `time.created`. */
  readBy: string | null;
  /** A turn that read this prompt has ENDED, so its reply is final: some
   *  reader has `time.completed` and no still-open reader is parented on the
   *  same user message (a turn's steps all parent on the user message the
   *  loop is on — an open sibling step means that turn is still running).
   *  Not "the newest reader completed": a NEWER turn already running (the
   *  user sent again after the reply) is a different turn and does not make
   *  the finished one any less final. False while every reading turn is
   *  still open. */
  readCompleted: boolean;
  /** Highest id clock on the tip, for placing the next mint above it. */
  newest: bigint | null;
  /** The box's `time.created` for this wire id, when the tip holds it. */
  createdMs: number | null;
}

/**
 * Did the step that opened assistant `m` begin AFTER `own` was persisted?
 * `true`/`false` only when the box stamped BOTH; `null` when a stamp is
 * missing, so the caller falls back to the id-order rule.
 */
function stepBeganAfter(
  own: PlacementTipMessage | undefined,
  m: PlacementTipMessage,
): boolean | null {
  if (typeof own?.created !== 'number' || !Number.isFinite(own.created)) return null;
  if (typeof m.created !== 'number' || !Number.isFinite(m.created)) return null;
  return m.created > own.created;
}

/**
 * Is this forwarded prompt answered, stranded, read, or still in line?
 *
 *  - answered: some assistant's `parentID` is this id.
 *  - readBy: some assistant NOT parented on it was opened by a step that
 *    began after this prompt was persisted — both `time.created` stamps say
 *    so. It was in that step's input; OpenCode parents each step on the
 *    newest user message (by `time.created` since 1.18.15) and answers
 *    everything else in the transcript in that same step. Not stranded,
 *    whatever the ids say.
 *  - stranded: no assistant answers it, no step read it, and some assistant
 *    has a higher id AND a parent that sorts BELOW this id — with the stamps
 *    agreeing that its step began first, or a stamp missing. That step read
 *    the transcript before this prompt existed; on an id-ordered box the
 *    loop's exit check sorts this prompt under it and never runs it. An
 *    assistant with a higher id whose parent is a NEWER user message is "in
 *    line", not stranded, on any box.
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
  let reader: PlacementTipMessage | null = null;
  // Every reader, grouped by the user message its step parented on — one
  // group per turn that read this prompt. A group with a completed step and
  // no open one is a turn that ended with this prompt in its input.
  const readerTurns = new Map<string, { completed: boolean; open: boolean }>();
  if (mine !== null) {
    for (const m of tip) {
      if (m.role !== 'assistant') continue;
      if (m.parentID === wireMessageId) {
        answered = true;
        break;
      }
      const began = stepBeganAfter(own, m);
      if (began === true) {
        if (isLaterTipMessage(m, reader)) reader = m;
        const key = typeof m.parentID === 'string' ? m.parentID : '';
        const group = readerTurns.get(key) ?? { completed: false, open: false };
        if (typeof m.completed === 'number') group.completed = true;
        else group.open = true;
        readerTurns.set(key, group);
        continue;
      }
      const at = wireIdTime(m.id);
      const parentAt = typeof m.parentID === 'string' ? wireIdTime(m.parentID) : null;
      if (at === null || parentAt === null) continue;
      if (at > mine && parentAt < mine) strandedBy = m.id;
    }
  }
  const read = !answered && reader !== null;
  let readCompleted = false;
  if (read) {
    for (const group of readerTurns.values()) {
      if (group.completed && !group.open) {
        readCompleted = true;
        break;
      }
    }
  }
  return {
    answered,
    stranded: !answered && !read && strandedBy !== null,
    strandedBy: answered || read ? null : strandedBy,
    readBy: read ? reader!.id : null,
    readCompleted,
    newest,
    createdMs,
  };
}

/**
 * Was this delivered id ANSWERED — by the turn it opened, or by the step of a
 * later sibling that read it? The drain's already-answered guard asks this
 * for every id a row was ever posted under, so a redelivery — whatever path
 * re-queued it — never runs a prompt the model has already answered.
 *
 *  - an assistant parented on it: answered, open or not (that IS its turn).
 *  - a turn that read it has ENDED (`readCompleted`): answered — its reply is
 *    final, whether or not a newer turn is already running.
 *  - every reading turn still open: not yet — an abort can still lose the
 *    reply.
 *  - stamps missing: the parent-only rule, as before.
 */
export function promptAnsweredOnTip(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): boolean {
  const v = strandedPlacement(tip, wireMessageId);
  return v.answered || v.readCompleted;
}

/**
 * Has the loop REACHED this user message — read it into a step? True when an
 * assistant answers it, or when a step provably began after it was persisted
 * (`time.created` on both), or — stamps missing — when an assistant with a
 * higher id is parented on it or on a NEWER user message (that step's read
 * included it). A message the loop has not reached is still just text in the
 * transcript: it can be taken back out without the model ever having seen it.
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
    // ID order is not causality: ids are minted from the SENDER's clock. A
    // message deliberately placed BELOW the running step's parent
    // (under-placement) has a lower id than an assistant whose step began
    // before it even arrived, and a message LIFTED to the box clock has a
    // higher id than the merged reply's parent that was persisted after it.
    // `time.created` is stamped at PERSISTENCE by the box, on one clock —
    // when both stamps exist, a step read this message exactly when it
    // STARTED after the message was persisted, whatever the ids say.
    const began = stepBeganAfter(own, m);
    if (began !== null) {
      if (began) return true;
      continue;
    }
    const at = wireIdTime(m.id);
    const parentAt = typeof m.parentID === 'string' ? wireIdTime(m.parentID) : null;
    if (at === null || parentAt === null || at <= mine || parentAt < mine) continue;
    return true;
  }
  return false;
}

/**
 * Is there an OPEN user message ABOVE this id — placed (not stranded), not
 * read by any step, unanswered? Then a message that sits BELOW it is not
 * lost: OpenCode's next step parents on the newest user message and hands
 * the model the whole transcript, so everything under it is answered in that
 * step. This is what lets a late delivery keep its ORIGINAL (send-ordered) id
 * instead of re-minting to the top, and what lets the reconciler leave a
 * stranded row alone. A user message a step has already read is not "open":
 * the step that covers it has begun, and nothing persisted after that step
 * began is in its input.
 */
export function openUserAbove(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): boolean {
  return openUsersAbove(tip, wireMessageId).length > 0;
}

/**
 * The ids that make `openUserAbove` true, in tip order — every OPEN user
 * message above this id. Empty when there is none.
 *
 * The drain needs the ids, not the boolean: an open sibling above is a
 * reason to place BELOW it only when that sibling was SENT AFTER this
 * prompt. A wire id is minted by the sender and a live-turn delivery is
 * LIFTED to the box clock (`mintLivePlacement`), so an id above this prompt
 * can belong to a prompt sent BEFORE it. The drain resolves each id to its
 * inbox row's send instant (`underPlacementKeepsSendOrder`) before it decides.
 */
export function openUsersAbove(
  tip: ReadonlyArray<PlacementTipMessage>,
  wireMessageId: string,
): string[] {
  const mine = wireIdTime(wireMessageId);
  if (mine === null) return [];
  const open: string[] = [];
  for (const m of tip) {
    if (m.role !== 'user' || m.id === wireMessageId) continue;
    const at = wireIdTime(m.id);
    if (at === null || at <= mine) continue;
    const v = strandedPlacement(tip, m.id);
    if (!v.answered && !v.stranded && v.readBy === null) open.push(m.id);
  }
  return open;
}

/**
 * Is `candidate` the LATER of two transcript messages?
 *
 * `time.created` first. The box stamps it at persistence on one clock, and it
 * is what OpenCode itself orders the transcript by: `MessageV2.page()` runs
 * `orderBy(desc(time_created), desc(id)).limit(n + 1)` and reverses, in every
 * version we run. Since 1.18.15 it is also what `latest()` uses.
 *
 * The id clock is the FALLBACK, for a message whose stamp we could not read
 * (an older daemon build, a parse that dropped it). It is a fallback and not
 * the primary because a wire id is minted by the SENDER — the browser, the
 * CLI, or this process's placement minter — while `time.created` is stamped by
 * the box, so the two disagree whenever a prompt is deliberately placed off
 * the box's own clock, which is exactly what `mintLivePlacement` does.
 *
 * A raw string `>` on the ids would happen to agree with the id clock today,
 * because `msg_` is followed by 12 zero-padded lowercase hex digits under one
 * fixed prefix. That is an accident of the current id format, not a contract —
 * so nothing here compares ids as strings except as the last tiebreak, when
 * neither a stamp nor a decodable clock is available on both sides.
 */
export function isLaterTipMessage(
  candidate: PlacementTipMessage,
  incumbent: PlacementTipMessage | null | undefined,
): boolean {
  if (!incumbent) return true;
  const a =
    typeof candidate.created === 'number' && Number.isFinite(candidate.created)
      ? candidate.created
      : null;
  const b =
    typeof incumbent.created === 'number' && Number.isFinite(incumbent.created)
      ? incumbent.created
      : null;
  // Both stamped and different: the box's own clock settles it outright.
  if (a !== null && b !== null && a !== b) return a > b;
  // Same millisecond, or a stamp missing on either side — fall through to the
  // id clock, which is `page()`'s own sub-millisecond tiebreak.
  const at = wireIdTime(candidate.id);
  const bt = wireIdTime(incumbent.id);
  if (at !== null && bt !== null && at !== bt) return at > bt;
  return candidate.id > incumbent.id;
}

/** Is the box mid-step — its newest assistant message still open? */
export function tipIsBusy(tip: ReadonlyArray<PlacementTipMessage>): boolean {
  let newest: PlacementTipMessage | null = null;
  for (const m of tip) {
    if (m.role !== 'assistant') continue;
    if (isLaterTipMessage(m, newest)) newest = m;
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
