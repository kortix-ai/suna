/**
 * Whether a call is allowed to hand another request to Kortix right now.
 *
 * THE BUG. A live call handed Kortix the same question over and over. A stray
 * transcription artifact ("dog.") led the voice model to assert something false
 * about the project; that claim then sat in its OWN conversation history as
 * fact, so every correct answer Kortix sent back contradicted what it believed,
 * and it asked again to resolve the contradiction — "clarify whether the project
 * involves dogs", "summarize all references to dog" — indefinitely. Each ask is
 * a real Kortix turn: $0.02-$0.03 and up to 3.2k tokens. It ran until a human
 * hung up.
 *
 * TWO GUARDS, DELIBERATELY BOTH.
 *  - IN FLIGHT (the cure): one hand-off at a time. Two overlapping asks each get
 *    their own answer-watch, so their answers arrive interleaved and can
 *    contradict each other — which is the raw material the loop feeds on. A
 *    second ask while one is outstanding is refused with an explanation the
 *    model can act on.
 *  - RATE (the containment that already shipped, kept as-is): at most
 *    {@link MAX_ASKS_PER_WINDOW} asks a minute. A ceiling cannot make a model
 *    reason better, but it converts an unbounded spend into a bounded one, and
 *    it still catches a loop that somehow settles fast enough to never look
 *    outstanding.
 *
 * WHY THE STATE IS IN POSTGRES AND NOT IN THIS PROCESS. There is no in-process
 * call registry by design (see runtime.ts's `isCallLive`), the worker's MCP calls
 * land on whichever API pod answers, and a per-pod counter would let a loop run
 * N times per pod. `voice_call_turns` already carries a `tool`-role line per ask,
 * so the ledger is the transcript itself — one row per hand-off, one row per
 * settle, ordered by the same monotonic `cursor` everything else in voice uses.
 *
 * This module is deliberately PURE — rows in, verdict out. The query that
 * produces the rows lives in runtime.ts next to its table; the decision lives
 * here because the decision is what has to be exhaustively testable.
 */

/** `speaker` of the transcript row written when a hand-off STARTS. */
export const ASK_SPEAKER = 'ask_kortix';
/** `speaker` of the row written when that hand-off ends, however it ends. */
export const ASK_SETTLED_SPEAKER = 'ask_kortix_done';

/** How many hand-offs one call may start in {@link ASK_WINDOW_MS}. */
export const MAX_ASKS_PER_WINDOW = 5;
export const ASK_WINDOW_MS = 60_000;

/**
 * THE BOUND ON "OUTSTANDING", and the reason it exists.
 *
 * An ask is normally settled by answer-watch.ts, which writes the settle row in a
 * `finally` and therefore covers every way its watch can end — an answer, a
 * failed turn, a turn with nothing to say, an unreadable session, or its own
 * six-minute deadline. But that watch runs in ONE API process. If that pod is
 * killed mid-watch, nothing ever writes the settle row, and a purely
 * relational "is there an unsettled ask" would wedge the call's hand-off for the
 * rest of the meeting — the call could still talk, but could never get an answer
 * again, and would have no idea why.
 *
 * So an unsettled ask expires. This is set just past answer-watch's own
 * MAX_WAIT_MS (6 min) so the two can never disagree: in every case where the
 * watch is alive it settles first, and this only ever fires for a watch that
 * died with its process. `unit-voice-ask-ledger.test.ts` asserts that ordering
 * against the real constant rather than trusting this comment.
 */
export const ASK_INFLIGHT_TIMEOUT_MS = 6.5 * 60_000;

/** One ledger row: which side it is, when, and its position in the call. */
export interface AskLedgerEntry {
  /** `voice_call_turns.cursor` — the monotonic order, never wall-clock. */
  cursor: number;
  /** {@link ASK_SPEAKER} or {@link ASK_SETTLED_SPEAKER}. */
  speaker: string;
  /** `created_at` as epoch ms; used only for the two time bounds. */
  at: number;
}

export type AskVerdict =
  | { allow: true }
  | { allow: false; reason: 'in_flight' | 'rate'; error: string };

/**
 * What the voice model is told when it asks twice.
 *
 * Written to be RELAYED, not reported as a fault: it reaches the model as a tool
 * error, and apps/voice-agent's `send_prompt` passes a refusal straight through
 * for the model to put into its own words. It has to explain the situation
 * ("still coming"), give the model something to do instead ("say you are
 * waiting"), and pre-empt the specific rationalisation that drove the real loop
 * — that asking again might resolve a contradiction.
 */
export const IN_FLIGHT_MESSAGE =
  'You already handed a request to Kortix and the answer has not come back yet. It arrives on ' +
  'its own — asking again does not make it faster, and two requests in flight is what makes ' +
  'answers arrive out of order and contradict each other. Do not send this. Tell the room in ' +
  'one short sentence that you are still waiting, then stop talking. If an answer you already ' +
  'got disagrees with something you said earlier, the ANSWER is right — say so and move on ' +
  'rather than asking Kortix to settle it.';

const RATE_ADVICE =
  'Stop asking and answer the room from what you already have. If an earlier answer ' +
  'contradicted something you said before, the LATER answer is the correct one — say ' +
  'that plainly and move on.';

function rateMessage(asks: number): string {
  return `You have asked Kortix ${asks} times in the last minute and are repeating yourself. ${RATE_ADVICE}`;
}

/**
 * The verdict for one prospective ask.
 *
 * `entries` may arrive in any order; it is sorted by `cursor` here rather than by
 * `at`, because two rows can share a millisecond and a wall-clock tie would pick
 * the wrong one — the same reasoning that makes `cursor` the ordering key for the
 * transcript itself.
 *
 * In-flight is checked BEFORE rate: when both would refuse, "you already asked
 * and it is still coming" is the more accurate and more actionable thing to say
 * than "you are repeating yourself". Neither refusal lets an ask through, so the
 * ceiling is unaffected by the ordering.
 */
export function judgeAsk(entries: readonly AskLedgerEntry[], now: number): AskVerdict {
  const newestFirst = [...entries].sort((a, b) => b.cursor - a.cursor);

  // The newest ledger row decides in-flight: a start with no settle after it is
  // an ask still out there. Rows of any other speaker are not ledger rows and
  // are already excluded by the query, but filtering here keeps this honest for
  // a caller that passes the whole transcript.
  const newest = newestFirst.find(
    (e) => e.speaker === ASK_SPEAKER || e.speaker === ASK_SETTLED_SPEAKER,
  );
  if (newest?.speaker === ASK_SPEAKER && now - newest.at < ASK_INFLIGHT_TIMEOUT_MS) {
    return { allow: false, reason: 'in_flight', error: IN_FLIGHT_MESSAGE };
  }

  const asks = newestFirst.filter(
    (e) => e.speaker === ASK_SPEAKER && now - e.at < ASK_WINDOW_MS,
  ).length;
  if (asks >= MAX_ASKS_PER_WINDOW) {
    return { allow: false, reason: 'rate', error: rateMessage(asks) };
  }

  return { allow: true };
}

/**
 * How far back the ledger query has to look to answer both questions. The
 * in-flight window is the longer of the two, plus a minute of slack so a row
 * that matters can never fall off the edge and read as "no ask at all".
 */
export const ASK_LEDGER_LOOKBACK_MS = ASK_INFLIGHT_TIMEOUT_MS + 60_000;

/**
 * Row cap for that query. An ask and a settle per hand-off, and the rate ceiling
 * is 5 asks a window, so a healthy call needs a handful; this is generous enough
 * that only a pathological call clips it, and a clipped page still contains the
 * newest rows (the query orders by cursor DESC), which is what both checks read.
 */
export const ASK_LEDGER_LIMIT = 24;
