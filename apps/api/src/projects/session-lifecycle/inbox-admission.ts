import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  RUNNING_SANDBOX_STATUSES,
  storedSandboxTurns,
  type StoredSandboxTurn,
} from '../sandbox-turn-lifecycle';
import { reconcileInboxTurn } from './inbox-turn-recovery';
import { inboxPrecedesRow } from './inbox-order';
import { readLiveTurnPhase, type LiveTurnPhase } from './live-turn-phase';
import type { InboxAdmissionReason, SessionLifecycleCommandRow } from './store';

/**
 * The inbox's admission gate.
 *
 * A QUEUED MESSAGE RUNS IN ORDER AND GETS ITS OWN ANSWER — unless it steers.
 * A prompt sits in `session_lifecycle_commands` until the session's turn is
 * over AND every older prompt has left the delivery path. Queue List prompts
 * always wait for natural turn completion. Quick Queue STEERS into the running
 * turn. The one exception is a response that is STREAMING TEXT: a prompt typed
 * over it ENDS it and runs next (below).
 *
 * WHY THE MERGE IS THE WHOLE QUESTION. OpenCode picks up new user messages at
 * STEP boundaries INSIDE a running turn, and it "parents each step on the
 * newest user message and answers everything before it in that step"
 * (`forwarded-placement.ts`). So a prompt forwarded into a live turn is merged
 * into whatever step reaches it. Measured 2026-09-04 — a 13-step research turn
 * with "tell me HI" and "tell me bye" queued behind it produced exactly one
 * reply, "bye". The first message was never spoken.
 *
 * That measurement is why forwarding (`4ee30a9c3b`) was reverted, and it still
 * stands for the Queue List lane. What changed is WHICH PROMPTS ARE FORWARDED.
 * In 2026-09-04 there were no placement lanes — they arrived 2026-09-17
 * (`cea48e1b66`) — so two independent QUESTIONS were merged and the user
 * rightly expected two answers. A merge is the defect for a queue and the point
 * of steering: a steer is a correction to work already running, and one answer
 * accounting for it is the outcome asked for. So only the Quick Queue lane
 * forwards.
 *
 * ONE STEER PER TURN WAS THE BOUND, AND IT IS GONE (2026-09-21). It existed so
 * a second forwarded prompt could not go unspoken inside a shared step. The
 * owner's rule replaces it: "However many quick queue prompts are being added,
 * they should all be sent together to the agent, not one by one … under the
 * hood the agent responds to them in a grouped format." So a whole pending
 * Quick Queue GROUP steers at once (`quick-queue-group.ts`): rows 1..N-1 are
 * posted with `noReply: true` — persisted, no reply started — and row N is
 * posted normally, carrying a hidden `synthetic` instruction to answer every
 * message of the group in order. Exactly one reply exists, so the "HI / bye"
 * loss has no mechanism left, and `turnAlreadySteered` (the dep that enforced
 * the bound) is deleted.
 *
 * THAT MEANS A SESSION CAN HOLD MORE THAN ONE RECORDED TURN. A steer is its own
 * `/prompt_async` POST, so the proxy opens a second `activeTurns` entry for it
 * even though OpenCode merges it into the one running reply. `turns.length === 1`
 * used to gate every decision below, which wedged every Quick Queue prompt sent
 * after the first steer until the turn ended. `steerTargetTurn` picks the
 * NEWEST accepted turn instead — the message OpenCode parents its next step on,
 * and the message the daemon's interrupt calls newest.
 *
 * A TEXT STREAM HAS NO STEP BOUNDARY, SO A STEER INTO IT IS NEVER READ. A tool
 * call ends a step every few seconds, which is why steering works during tool
 * work. A streamed markdown answer is ONE step from its first character to its
 * last. Reported by the owner and reproduced 2026-09-21: "tell me about
 * pigeons", five seconds into the answer, Enter on "crow vs pigeon". The steer
 * was admitted, the UI showed it as working, and the pigeon answer streamed to
 * its end before anything read it. "When I sent two prompts, the first prompt
 * response should be stopped immediately. This is only happening with the text
 * response not with the tool call thing." So the head Quick Queue prompt asks
 * what the turn is doing (`readLiveTurnPhase`), and for a text stream admission
 * returns the `interruptAtBoundary` refusal instead of `{ admit: true }`. The
 * machinery behind that refusal already existed: the drain requeues the row
 * durably, THEN arms the daemon (`quick-queue-interrupt.ts`), whose check
 * aborts at once when no tool is running; the turn-end relay promotes this
 * same row and it runs as the next turn.
 *
 * ONLY A PROMPT TYPED OVER THE RESPONSE MAY END IT: the row must have been
 * created at or after the active turn started. Measured 2026-09-18 on a real
 * sandbox — a long turn A, then Quick Queue prompts B, C, D: B ended A, C
 * became head and ended B's turn, D ended C's. Replies B and C came back
 * `MessageAbortedError` with zero characters; N prompts lost N-1 answers. C
 * and D were already waiting before the turn they killed began, so they were
 * never a reaction to it. They steer or wait. This replaces the earlier
 * `turnStartedByQuickQueue` guard, which refused by WHO started the turn and
 * so also refused the owner's case (a prompt typed over a Quick Queue
 * prompt's own streamed answer).
 *
 * THE EXACT GUARANTEE, because the abort is now immediate: a prompt can end
 * only a turn that STARTED BEFORE IT WAS CREATED (`startedAtMs` is stamped when
 * delivery begins). B ends A's text and B's turn starts about a second later,
 * so a C typed after that, while B is already writing text, ends B — C was
 * typed over B's answer, which is the owner's rule. D predates C's turn and
 * cannot end it. A burst therefore loses at most the first successor's partial
 * answer, never N-1.
 *
 * TWO WINDOWS THIS DOES NOT CLOSE, both by decision, both still the reported
 * symptom for the prompt inside them:
 *   • REASONING AND THE ANSWER ARE ONE STEP. A prompt sent while the model is
 *     still reasoning reads 'other' and steers; if that step goes on to stream
 *     text, the steer sits unread until the text ends. A reasoning step is not
 *     ended because reasoning opens every TOOL step as well, and the page
 *     cannot say which one this is; ending those is the half-finished-work
 *     loss steering exists to prevent. Open product decision, recorded in the
 *     learnings register.
 *   • A PRE-DATED row steered into a text stream is unread until the text ends.
 *
 * For every prompt that does NOT steer, the gap forwarding was removing is
 * gone by other means: `promoteNextInboxRow` is AWAITED on the daemon's own
 * `session.idle` relay (`routes/r4.ts`, "THE TURN ENDED — the session's next
 * queued prompt is admissible NOW"), and the backoff below is now a 2s-capped
 * fallback rather than the 30s ceiling that produced the measured dead air.
 * A queued message therefore goes out on the turn-end event, not on a clock.
 *
 * WAITING IS NOT POLLING. A refused row does not sit out a backoff clock: the
 * instant the turn ends, `promoteNextInboxRow` makes the session's next row due
 * and drains it. The reaper is a recovery wake. The backoff below only covers
 * the gap a lost kick would leave, so it stays cheap and capped — 30s here
 * compounded to 27s / 45s / 75s of dead air behind ~1s deliveries (dev,
 * 2026-08-18).
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
export const INBOX_ORDER_BACKOFF_MS = 300;
/**
 * The ceiling is LOW on purpose. A refused row is not polling for a whole cold
 * boot any more: accepted delivery calls `promoteNextInboxRow` and makes the
 * session's next queued row due NOW, then kicks a targeted drain. The terminal
 * relay and reaper repeat that wake for recovery. This backoff only covers the
 * gap a lost kick would leave. 30s here was the entire "queue does not send
 * between turns" experience: three quick messages compounded to 27s / 45s /
 * 75s of dead air behind ~1s deliveries.
 */
export const INBOX_ORDER_MAX_BACKOFF_MS = 2_000;
export const INBOX_BACKOFF_FREE_REFUSALS = 4;

/** `base * 2^(refusals - free)`, capped. Pure, so the curve is testable. */
export function admissionBackoffMs(baseMs: number, capMs: number, refusals: number): number {
  // Clamped before the shift: `2 ** 1e9` is Infinity, and `Math.min` would
  // hand that straight to a Date constructor.
  const exponent = Math.min(Math.max(Math.trunc(refusals) - INBOX_BACKOFF_FREE_REFUSALS, 0), 16);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** How many times this row has already been put back by the admission gate. */
function admissionRefusals(result: unknown): number {
  const value = (result as { admission_refusals?: unknown } | null)?.admission_refusals;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The one thing that still holds a prompt back. Kept as a union because it is
 *  written into `result.admission_reason` and served as `GET .../prompts`'
 *  `reason`, where a second value may well appear again. */
export type InboxAdmission =
  | { admit: true }
  | {
      admit: false;
      reason: InboxAdmissionReason;
      retryAfterMs: number;
      /** Set only for the head Quick Queue row typed over a response that is
       *  streaming text: the drain arms the daemon's interrupt against exactly
       *  this turn AFTER the row is durably requeued. With no tool running the
       *  daemon aborts at once. */
      interruptAtBoundary?: { opencodeSessionId: string; messageId: string };
    };

/**
 * Does this session hold live turn authority right now?
 *
 * Exactly the predicate `GET /sessions/{id}/turn` serves from: the lifecycle
 * authority is `session_sandboxes.metadata.activeTurns` READ AGAINST A RUNNING
 * BOX. Metadata outlives the runtime, so a stopped box holds nothing whatever
 * its metadata still says. Pure over the two fields, so the truth table is
 * testable without a database.
 *
 * Admission, `GET .../turn`, and `settleOrphanedSandboxTurns` share this exact
 * predicate. A stopped box never holds authority even when stale metadata still
 * contains an active turn.
 */
export function sessionHoldsTurnAuthority(
  box: { status: string; metadata: Record<string, unknown> | null } | null,
): boolean {
  return (
    !!box && RUNNING_SANDBOX_STATUSES.has(box.status) && storedSandboxTurns(box.metadata).length > 0
  );
}

/**
 * The same question, against the database, for one session.
 *
 * The drain also uses this read when it must decide whether a client-minted id
 * is still correctly placed.
 */
export async function sessionHoldsLiveTurn(sessionId: string): Promise<boolean> {
  // `session_sandboxes.session_id` is UNIQUE, so this is the session's one box.
  // Served by idx_session_sandboxes_session.
  const [box] = await db
    .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  return sessionHoldsTurnAuthority(box ?? null);
}

export interface InboxAdmissionDeps {
  /** Recover a missed terminal relay from exact runtime evidence. */
  reconcileTurn?: (sessionId: string) => Promise<void>;
  /** The session's one sandbox row — its `metadata.activeTurns` is the turn
   *  authority `sessionHoldsTurnAuthority` reads. */
  readSandbox: (
    sessionId: string,
  ) => Promise<{ status: string; metadata: Record<string, unknown> | null } | null>;
  hasOlderPendingPrompt: (
    sessionId: string,
    row: SessionLifecycleCommandRow,
  ) => Promise<boolean>;
  /** Is another prompt of this session ALREADY CLAIMED and mid-delivery?
   *  Separate from the ordering read because it binds even a promoted row. */
  /** A LIST, not one id: the drain hands the whole Quick Queue GROUP it is
   *  delivering. Every row of a group is CLAIMED (`running`) when the head
   *  reaches admission, so without the exemption the head reads its own group
   *  as a sibling already on the wire and refuses itself for ever. */
  hasInFlightPrompt: (sessionId: string, exceptCommandIds: readonly string[]) => Promise<boolean>;
  /** What is the active turn doing right now? A READ, never an action — the
   *  arm stays in the drain, after the durable requeue. Only `'text'` changes
   *  the decision, and a throw, a rejection, or an absent dep all steer: a
   *  read that did not happen must never end someone's response. */
  readLiveTurnPhase?: (
    sessionId: string,
    active: { opencodeSessionId: string; messageId: string },
    actorUserId?: string | null,
  ) => Promise<LiveTurnPhase>;
}

/** What admission needs to know that is not on the row itself. */
export interface InboxAdmissionOptions {
  /** The OTHER rows of this delivery's Quick Queue group, all claimed by the
   *  same drain — see `hasInFlightPrompt`. */
  groupCommandIds?: readonly string[];
}

export const liveInboxAdmissionDeps: InboxAdmissionDeps = {
  reconcileTurn: reconcileInboxTurn,
  async readSandbox(sessionId) {
    const [box] = await db
      .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    return box ?? null;
  },
  async hasOlderPendingPrompt(sessionId, row) {
    const [older] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          inArray(sessionLifecycleCommands.status, ['queued', 'running']),
          // A HELD row is deliberately out of the line — the user stopped it.
          // Counting it would wedge every prompt they send afterwards behind a
          // row that is, by construction, never due.
          sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') <> 'true'`,
          inboxPrecedesRow(row),
          // Explicitly not itself. The tuple predicate already excludes this
          // row, but a row that blocks on itself waits for ever if a concurrent
          // writer changes one of its ordering fields.
          ne(sessionLifecycleCommands.commandId, row.commandId),
        ),
      )
      .limit(1);
    return !!older;
  },
  async hasInFlightPrompt(sessionId, exceptCommandIds) {
    const [running] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          eq(sessionLifecycleCommands.status, 'running'),
          exceptCommandIds.length > 0
            ? notInArray(sessionLifecycleCommands.commandId, [...exceptCommandIds])
            : undefined,
        ),
      )
      .limit(1);
    return !!running;
  },
  async readLiveTurnPhase(sessionId, active, actorUserId) {
    // `engine.ts` imports this module, so its endpoint resolution is reached
    // lazily — the same way `inbox-turn-recovery.ts` reaches `./store` — and
    // no static cycle exists. Bounded and fail-open inside `readLiveTurnPhase`.
    return readLiveTurnPhase(sessionId, active, actorUserId, {
      resolveEndpoint: async (id, actor) => {
        const { resolveSessionOpencodeEndpoint } = await import('./engine');
        return resolveSessionOpencodeEndpoint(id, actor);
      },
    });
  },
};

/**
 * WHICH recorded turn is the response a steer goes into.
 *
 * A session can hold more than one `activeTurns` entry, and after 2026-09-21
 * that is ordinary rather than exotic: a steer is its own `/prompt_async` POST,
 * so the proxy opens a second entry for it (`preview.ts`'s
 * `beginTurnLifecycle`) while OpenCode merges it into the one running reply.
 * The previous `turns.length === 1 ? turns[0] : null` therefore refused every
 * Quick Queue prompt sent after the first steer until the whole turn ended.
 *
 * The NEWEST accepted turn is the right answer for both decisions that use it:
 * OpenCode parents each later step on the newest user message, so that is the
 * id `liveTurnPhaseFromPage` must match a step against, and it is the id the
 * daemon's interrupt calls newest (anything older is answered `stale` and
 * disarmed — `quick-queue-interrupt.ts`).
 *
 *  - `state: 'delivering'` is excluded: that POST has not been accepted, so
 *    nothing of it exists to read a step against.
 *  - A turn with no `messageId` is excluded for the same reason.
 *  - A TOTAL order, so the choice cannot depend on jsonb key order:
 *    `startedAtMs` first (a legacy record has none and sorts lowest), then the
 *    wire id, which is time-ordered because `msg_<hex clock>` is minted from a
 *    clock (`wire-message-id.ts`).
 */
export function steerTargetTurn(
  turns: readonly StoredSandboxTurn[],
): (StoredSandboxTurn & { messageId: string }) | null {
  let best: (StoredSandboxTurn & { messageId: string }) | null = null;
  for (const turn of turns) {
    if (turn.state !== 'active' || !turn.messageId) continue;
    const candidate = turn as StoredSandboxTurn & { messageId: string };
    if (best === null) {
      best = candidate;
      continue;
    }
    const started = (candidate.startedAtMs ?? -1) - (best.startedAtMs ?? -1);
    if (started > 0 || (started === 0 && candidate.messageId > best.messageId)) best = candidate;
  }
  return best;
}

/**
 * Does this row STEER — is it to be placed into the running turn rather than
 * held behind it?
 *
 * Quick Queue IS steering; that is what the lane means. A Queue List entry is a
 * queue by definition — it waits for the active response and gets its own
 * answer. A prompt with no placement (a first prompt, an automation, an older
 * producer) is not a correction to work in flight, so it queues too.
 */
export function promptSteers(row: SessionLifecycleCommandRow): boolean {
  return (row.payload as { placement?: unknown } | null)?.placement === 'transcript';
}

/**
 * Was this prompt typed OVER the active response — created at or after the
 * instant its turn started?
 *
 * A prompt that was already waiting when the turn began (rapid-fire B, C, D
 * behind A) is not a reaction to what this turn is writing, so it may not end
 * it. A legacy `activeTurn` record has no start instant (`startedAtMs: null`),
 * and "typed over it" cannot be proven against a number nobody measured.
 */
export function promptTypedOverTurn(
  row: Pick<SessionLifecycleCommandRow, 'createdAt'>,
  turnStartedAtMs: number | null,
): boolean {
  if (turnStartedAtMs === null) return false;
  const createdAtMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Number.NaN;
  return Number.isFinite(createdAtMs) && createdAtMs >= turnStartedAtMs;
}

/** The phase read, FAILED OPEN. Anything that is not a clean `'text'` — no dep,
 *  a synchronous throw, a rejection — is `'other'`, which steers. */
async function liveTurnPhase(
  deps: InboxAdmissionDeps,
  row: SessionLifecycleCommandRow,
  active: { opencodeSessionId: string; messageId: string },
): Promise<LiveTurnPhase> {
  if (!deps.readLiveTurnPhase || !row.sessionId) return 'other';
  try {
    return await deps.readLiveTurnPhase(row.sessionId, active, row.actorUserId);
  } catch (err) {
    console.warn('[session-lifecycle] live turn phase read failed — steering instead', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'other';
  }
}

export async function admitInboxPrompt(
  row: SessionLifecycleCommandRow,
  deps: InboxAdmissionDeps = liveInboxAdmissionDeps,
  options: InboxAdmissionOptions = {},
): Promise<InboxAdmission> {
  // A row with no session cannot be ordered or gated. Admit it so the drain
  // reaches its own honest failure instead of requeueing it for ever.
  if (!row.sessionId) return { admit: true };

  /** This row plus the rest of its group: the claims THIS delivery owns, and
   *  therefore the ones "is a sibling already on the wire?" must not count. */
  const mine = [row.commandId, ...(options.groupCommandIds ?? [])];
  const refusals = admissionRefusals(row.result);
  const orderBackoffMs = admissionBackoffMs(
    INBOX_ORDER_BACKOFF_MS,
    INBOX_ORDER_MAX_BACKOFF_MS,
    refusals,
  );

  // A live turn holds delivery for Queue List, and for a row with no
  // placement, always. For the head Quick Queue row it depends on what the
  // turn is doing:
  //   • streaming text, and the row was typed over it — held, with the
  //     interrupt: the response ends NOW and this row runs as the next turn.
  //   • anything else — the prompt is PLACED INTO the running turn and the
  //     model reads it at its next step boundary. The whole pending Quick Queue
  //     GROUP goes in with it (`quick-queue-group.ts`), as one grouped answer.
  let sandbox = await deps.readSandbox(row.sessionId);
  if (sessionHoldsTurnAuthority(sandbox)) {
    // Only the head may reconcile, steer, or end a text stream. Quick Queue
    // sorts ahead of every Queue List row (`inbox-order.ts`), so its head does
    // so even while older Queue List entries wait.
    const isHead =
      !(await deps.hasInFlightPrompt(row.sessionId, mine)) &&
      !(await deps.hasOlderPendingPrompt(row.sessionId, row));
    if (deps.reconcileTurn && isHead) {
      await deps.reconcileTurn(row.sessionId);
      sandbox = await deps.readSandbox(row.sessionId);
    }
    if (sessionHoldsTurnAuthority(sandbox)) {
      // The NEWEST accepted turn, not "the only one" — see `steerTargetTurn`.
      const active = steerTargetTurn(storedSandboxTurns(sandbox?.metadata));

      // Only the head Quick Queue row acts on a live turn, and only on a turn
      // that has an accepted message to be read against. Everything else —
      // Queue List, no placement, a row behind another, a turn still
      // delivering — waits for the turn-end relay and arms nothing.
      if (isHead && promptSteers(row) && active) {
        // A TEXT STREAM IS ENDED, NOT STEERED — see the file header. Checked
        // in cost order: the clock comparison is free, the phase read is a
        // round trip to the box, so a row that may not end this turn never
        // pays for the answer.
        const identity = { opencodeSessionId: active.opencodeSessionId, messageId: active.messageId };
        if (
          promptTypedOverTurn(row, active.startedAtMs) &&
          (await liveTurnPhase(deps, row, identity)) === 'text'
        ) {
          return {
            admit: false,
            reason: 'turn_active',
            retryAfterMs: orderBackoffMs,
            interruptAtBoundary: identity,
          };
        }

        // STEERING. The prompt goes INTO this turn: the drain places it above
        // the transcript's tip (`forwarded-placement.ts`), OpenCode reads it
        // at its next step boundary, and the work in flight is kept. Ending a
        // turn in the middle of TOOL work is what threw away a half-written
        // file or a running migration.
        return { admit: true };
      }

      return { admit: false, reason: 'turn_active', retryAfterMs: orderBackoffMs };
    }
  }

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. A claimed row spends up to READY_DEADLINE_MS (5 min) inside
  // `continueSession` waiting for a cold box, with no message written for any
  // of it. Admitting a second prompt into that window races two deliveries of
  // one session, and OpenCode orders what it receives by ARRIVAL — so the loser
  // of that race is the message the user typed FIRST.
  if (await deps.hasInFlightPrompt(row.sessionId, mine)) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row and asked
  // for THAT message. QUEUE ORDER yields to that; the in-flight check above
  // does not, because it is about a delivery already happening rather than
  // about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (
    !promoted &&
    (await deps.hasOlderPendingPrompt(row.sessionId, row))
  ) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  return { admit: true };
}
