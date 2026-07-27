import { describe, expect, test } from 'bun:test';
import {
  ASK_INFLIGHT_TIMEOUT_MS,
  ASK_LEDGER_LIMIT,
  ASK_LEDGER_LOOKBACK_MS,
  ASK_SETTLED_SPEAKER,
  ASK_SPEAKER,
  ASK_WINDOW_MS,
  type AskLedgerEntry,
  IN_FLIGHT_MESSAGE,
  MAX_ASKS_PER_WINDOW,
  judgeAsk,
} from '../channels/voice/ask-ledger';

/**
 * ONE HAND-OFF AT A TIME.
 *
 * The call this exists for: a stray transcription artifact led the voice model
 * to assert something false about the project; the claim then sat in its own
 * history as fact, so every correct answer Kortix sent back contradicted it, and
 * it asked again to resolve the contradiction — indefinitely, at $0.02-$0.03 a
 * turn, until a human hung up. Overlapping asks are what made the answers
 * contradict each other in the first place: each one spawns its own answer
 * watch, so they arrive interleaved.
 *
 * `judgeAsk` is pure — rows in, verdict out — precisely so the awkward cases
 * (a settle that landed first, a watch that died with its pod, a clock that
 * ticked backwards) can be written down instead of reasoned about.
 */

/**
 * The invariant that makes the in-flight bound a BACKSTOP rather than a second,
 * racing deadline: answer-watch must always get to settle first. Read from
 * source because importing answer-watch.ts into a unit test would pull the whole
 * sandbox-proxy stack with it — and because unit-voice-recording.test.ts
 * registers a module mock for that path which is global for the entire test run.
 */
const ANSWER_WATCH_SOURCE = await Bun.file(
  new URL('../channels/voice/answer-watch.ts', import.meta.url).pathname,
).text();

const NOW = 1_700_000_000_000;

function ask(cursor: number, agoMs = 0): AskLedgerEntry {
  return { cursor, speaker: ASK_SPEAKER, at: NOW - agoMs };
}

function settled(cursor: number, agoMs = 0): AskLedgerEntry {
  return { cursor, speaker: ASK_SETTLED_SPEAKER, at: NOW - agoMs };
}

describe('the in-flight guard — the cure', () => {
  test('a first ask on a silent call goes through', () => {
    expect(judgeAsk([], NOW)).toEqual({ allow: true });
  });

  test('a second ask while one is outstanding is refused', () => {
    const verdict = judgeAsk([ask(1, 3_000)], NOW);
    expect(verdict.allow).toBe(false);
    if (verdict.allow) throw new Error('unreachable');
    expect(verdict.reason).toBe('in_flight');
    expect(verdict.error).toBe(IN_FLIGHT_MESSAGE);
  });

  test('an arriving answer clears it — the very next ask is allowed', () => {
    // This is the half that keeps the call usable. Without it, the guard is a
    // one-shot mute button on the only way the call gets information.
    expect(judgeAsk([ask(1, 30_000), settled(2, 1_000)], NOW)).toEqual({ allow: true });
  });

  test('outstanding is decided by the NEWEST pair, not by counting', () => {
    // Four completed hand-offs and a fifth in flight: the settled ones must not
    // cancel out the live one, and a live one must not be hidden by history.
    const history: AskLedgerEntry[] = [
      ask(1, 50_000),
      settled(2, 49_000),
      ask(3, 40_000),
      settled(4, 39_000),
      ask(5, 2_000),
    ];
    const verdict = judgeAsk(history, NOW);
    expect(verdict.allow).toBe(false);
    if (verdict.allow) throw new Error('unreachable');
    expect(verdict.reason).toBe('in_flight');
  });

  test('order comes from `cursor`, never from the clock', () => {
    // Two rows can share a millisecond — `voice_call_turns` is ordered on its
    // monotonic cursor everywhere else for exactly this reason, and a
    // wall-clock tie here would pick the wrong one and either wedge the call or
    // wave a duplicate ask through.
    const sameMs: AskLedgerEntry[] = [
      { cursor: 2, speaker: ASK_SETTLED_SPEAKER, at: NOW },
      { cursor: 1, speaker: ASK_SPEAKER, at: NOW },
    ];
    expect(judgeAsk(sameMs, NOW)).toEqual({ allow: true });

    const reversed: AskLedgerEntry[] = [
      { cursor: 1, speaker: ASK_SETTLED_SPEAKER, at: NOW },
      { cursor: 2, speaker: ASK_SPEAKER, at: NOW },
    ];
    expect(judgeAsk(reversed, NOW).allow).toBe(false);
  });

  test('input order does not matter — the caller may hand rows over any way round', () => {
    const rows = [settled(2, 1_000), ask(1, 30_000)];
    expect(judgeAsk(rows, NOW)).toEqual({ allow: true });
    expect(judgeAsk([...rows].reverse(), NOW)).toEqual({ allow: true });
  });

  test('rows that are not ledger rows are ignored, never mistaken for a settle', () => {
    // A caller passing a wider slice of the transcript must not be able to
    // clear an outstanding ask with an unrelated `run_command` line.
    const withNoise: AskLedgerEntry[] = [
      ask(1, 2_000),
      { cursor: 2, speaker: 'run_command', at: NOW },
    ];
    expect(judgeAsk(withNoise, NOW).allow).toBe(false);
  });
});

describe('the bound — a dead hand-off must not mute the call forever', () => {
  /**
   * answer-watch.ts settles the ask in a `finally`, so every ending it can
   * reach writes the row. What it cannot cover is its own process being killed
   * mid-watch: nothing then writes the settle, and a purely relational
   * "is there an unsettled ask" would block every hand-off for the rest of the
   * meeting — a call that can still talk but can never get an answer again, with
   * no way to tell why.
   */
  test('an unsettled ask expires and the next one goes through', () => {
    expect(judgeAsk([ask(1, ASK_INFLIGHT_TIMEOUT_MS + 1)], NOW)).toEqual({ allow: true });
  });

  test('it is still outstanding right up to the boundary', () => {
    expect(judgeAsk([ask(1, ASK_INFLIGHT_TIMEOUT_MS - 1)], NOW).allow).toBe(false);
    expect(judgeAsk([ask(1, ASK_INFLIGHT_TIMEOUT_MS)], NOW).allow).toBe(true);
  });

  test('an ask timestamped in the future is treated as live, not as expired', () => {
    // Clock skew between pods must never open the gate. `now - at` goes
    // negative, which is under the bound, which is "still in flight".
    expect(judgeAsk([{ cursor: 1, speaker: ASK_SPEAKER, at: NOW + 5_000 }], NOW).allow).toBe(false);
  });

  test("the ledger's expiry sits past answer-watch's own deadline", () => {
    const match = ANSWER_WATCH_SOURCE.match(
      /export const MAX_WAIT_MS = (\d+(?:\.\d+)?) \* ([\d_]+);/,
    );
    expect(match).not.toBeNull();
    const maxWaitMs = Number(match![1]) * Number(match![2]!.replace(/_/g, ''));
    expect(maxWaitMs).toBe(6 * 60_000);
    expect(ASK_INFLIGHT_TIMEOUT_MS).toBeGreaterThan(maxWaitMs);
  });

  test('every exit from the watch names an outcome, so none of them skips the settle', () => {
    // Five exits: no endpoint, a failed turn, a turn with nothing to say, an
    // answer, and the deadline. A `return;` with no outcome would compile and
    // silently leave the hand-off open until the expiry above.
    expect(ANSWER_WATCH_SOURCE).toContain('await settleAsk(callId, outcome);');
    expect(ANSWER_WATCH_SOURCE).toContain("return 'session unreadable';");
    expect(ANSWER_WATCH_SOURCE).toContain("return 'failed';");
    expect(ANSWER_WATCH_SOURCE).toContain("return 'nothing to say';");
    expect(ANSWER_WATCH_SOURCE).toContain("return 'answered';");
    expect(ANSWER_WATCH_SOURCE).toContain("return 'timed out';");
    const body = ANSWER_WATCH_SOURCE.slice(
      ANSWER_WATCH_SOURCE.indexOf('async function watchForAnswer'),
    );
    expect(body).not.toContain('return;');
  });
});

describe('the rate ceiling — the containment that already shipped, kept', () => {
  /** Five asks that all settled instantly: nothing is in flight, but the call is looping. */
  function settledPairs(count: number, agoMs: number): AskLedgerEntry[] {
    const rows: AskLedgerEntry[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(ask(i * 2 + 1, agoMs));
      rows.push(settled(i * 2 + 2, agoMs));
    }
    return rows;
  }

  test('under the ceiling is allowed', () => {
    expect(judgeAsk(settledPairs(MAX_ASKS_PER_WINDOW - 1, 5_000), NOW)).toEqual({ allow: true });
  });

  test('at the ceiling is refused, and says how many', () => {
    const verdict = judgeAsk(settledPairs(MAX_ASKS_PER_WINDOW, 5_000), NOW);
    expect(verdict.allow).toBe(false);
    if (verdict.allow) throw new Error('unreachable');
    expect(verdict.reason).toBe('rate');
    expect(verdict.error).toContain(`${MAX_ASKS_PER_WINDOW} times in the last minute`);
    // The clause that lets a model stop chasing its own contradiction.
    expect(verdict.error).toContain('the LATER answer is the correct one');
  });

  test('only asks inside the window count — the ceiling is a rate, not a total', () => {
    expect(judgeAsk(settledPairs(MAX_ASKS_PER_WINDOW, ASK_WINDOW_MS + 1), NOW)).toEqual({
      allow: true,
    });
  });

  test('settles never count as asks', () => {
    const settlesOnly = Array.from({ length: 20 }, (_, i) => settled(i + 1, 1_000));
    expect(judgeAsk(settlesOnly, NOW)).toEqual({ allow: true });
  });

  test('in-flight is reported ahead of rate when both would refuse', () => {
    // Both refuse, so the ceiling is unaffected — but "you already asked and it
    // is still coming" is the accurate and actionable thing to tell the model,
    // where "you are repeating yourself" is neither.
    const rows = [...settledPairs(MAX_ASKS_PER_WINDOW, 5_000), ask(999, 1_000)];
    const verdict = judgeAsk(rows, NOW);
    expect(verdict.allow).toBe(false);
    if (verdict.allow) throw new Error('unreachable');
    expect(verdict.reason).toBe('in_flight');
  });
});

describe('the refusal is written to be spoken, not to be logged', () => {
  test('it tells the model what is happening, what to do, and what not to conclude', () => {
    expect(IN_FLIGHT_MESSAGE).toContain('already handed a request to Kortix');
    expect(IN_FLIGHT_MESSAGE).toContain('Do not send this');
    expect(IN_FLIGHT_MESSAGE).toContain('still waiting');
    // Pre-empts the exact rationalisation that drove the real loop: that asking
    // again might resolve the contradiction between the answer and its belief.
    expect(IN_FLIGHT_MESSAGE).toContain('the ANSWER is right');
    expect(IN_FLIGHT_MESSAGE).not.toContain('error');
  });
});

describe('the query bounds the verdict is only valid within', () => {
  test('the lookback outlives the longer of the two windows', () => {
    expect(ASK_LEDGER_LOOKBACK_MS).toBeGreaterThan(ASK_INFLIGHT_TIMEOUT_MS);
    expect(ASK_LEDGER_LOOKBACK_MS).toBeGreaterThan(ASK_WINDOW_MS);
  });

  test('the row cap leaves room for a full rate window of pairs', () => {
    expect(ASK_LEDGER_LIMIT).toBeGreaterThanOrEqual(MAX_ASKS_PER_WINDOW * 2);
  });
});
