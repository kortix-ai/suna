import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Mobile copy of apps/web/src/features/session/turn/streaming-cadence.ts.
 * Same algorithm and the same tests; keep the two in step. Differences, all
 * for native: renders at ~20 Hz instead of ~30 (each render re-parses the
 * tail block through markdown-it and rebuilds its native views), no wait for
 * a per-word fade at the end (native text spans cannot fade), and a
 * backgrounded app counts as a hidden tab.
 *
 * Streamed text reaches the client in network chunks of any size and at any
 * spacing: one token every 16 ms, or a paragraph after a 300 ms stall.
 * Painting each chunk as it lands is what made a reply arrive in lumps.
 *
 * The pacer reveals the received text word by word at the speed the text is
 * ARRIVING (measured over the last `ARRIVAL_WINDOW_MS`), and keeps a small
 * reserve in hand so the reveal does not stall in the gap between two chunks.
 * The reserve is sized from the largest recent gap. The result is one
 * steady velocity that follows the model's real speed — the reveal does not
 * surge after each chunk and then crawl while the reserve empties.
 */

/** Window over which the arrival speed and the chunk gaps are measured. */
const ARRIVAL_WINDOW_MS = 1200;
/** Bounds of the reserve, as time at the arrival speed. */
const MIN_RESERVE_MS = 90;
const MAX_RESERVE_MS = 450;
/** How hard the speed corrects toward the reserve: the error closes by ~63% in this time. */
const CORRECTION_MS = 350;
/** How fast the reveal speed follows its target. Without it a big chunk is a visible jump. */
const RATE_SMOOTHING_MS = 150;
/** Slowest reveal while text is waiting, so a small backlog never trickles letter by letter. */
export const STREAM_MIN_CPS = 30;
/** After the stream ends the rest drains at this time constant, so the end is not held back. */
export const STREAM_END_LAG_MS = 120;
/**
 * Minimum gap between two renders of the streaming message (~20 a second).
 * Each render re-splits the message (incrementally, `split-blocks.ts`) and
 * re-parses the tail block into native views: the JS-thread cost of a stream
 * on a low-end Android phone. Word steps 48 ms apart still read as typing.
 */
export const STREAM_COMMIT_MS = 48;
/** Mobile has no per-word fade (see the header), so the end settles as soon as the text is complete. */
export const STREAM_FADE_MS = 0;
/**
 * A segment that mounts while streaming with at most this much text is typed
 * from the start: it is the first delta batch of a new answer. More than this
 * is a refresh or a tab switch mid-answer, and shows at once.
 */
export const RETYPE_MAX_CHARS = 400;
/** A frame gap longer than this (a stalled main thread) is not budget. */
const MAX_FRAME_MS = 100;

/**
 * A "word" that is only markdown syntax (`##`, `-`, `1.`, `>`, `|`, a fence)
 * renders as an empty block until its first real word arrives. Revealing it
 * together with that word keeps an empty heading or bullet from flashing in.
 */
const SYNTAX_ONLY = /^(?:[#>*+\-|`~=_:]+|\d+[.)])$/;

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';

/**
 * The end of the reveal for a char `budget` past `from`, on a word boundary.
 *
 * The cut extends to the end of the word it lands in, so a word never shows
 * half-written. While the stream is live the trailing word may still be
 * arriving: the cut stops before it (`final: false`). A syntax-only word
 * pulls the next word in with it (see `SYNTAX_ONLY`).
 */
export function revealCut(text: string, from: number, budget: number, final: boolean): number {
  const len = text.length;
  let cut = Math.min(len, from + Math.max(0, Math.floor(budget)));
  for (;;) {
    while (cut < len && !isSpace(text[cut])) cut++;
    if (cut === len && !final) {
      // The trailing word may be incomplete: back off to the space before it,
      // and past any syntax-only word that would then end the text.
      while (cut > from && !isSpace(text[cut - 1])) cut--;
      for (;;) {
        let end = cut;
        while (end > from && isSpace(text[end - 1])) end--;
        let start = end;
        while (start > from && !isSpace(text[start - 1])) start--;
        if (start === end || !SYNTAX_ONLY.test(text.slice(start, end))) return cut;
        cut = start;
      }
    }
    if (cut >= len) return len;
    let wordStart = cut;
    while (wordStart > from && !isSpace(text[wordStart - 1])) wordStart--;
    if (!SYNTAX_ONLY.test(text.slice(wordStart, cut))) return cut;
    while (cut < len && isSpace(text[cut])) cut++;
  }
}

export interface PacerClock {
  now: () => number;
  requestFrame: (fn: () => void) => unknown;
  cancelFrame: (id: never) => void;
  /** No frames run (a backgrounded app): the pacer shows the text at once. */
  hidden: () => boolean;
}

const defaultClock: PacerClock = {
  now: () => performance.now(),
  requestFrame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (id) => cancelAnimationFrame(id),
  // A backgrounded app runs no frames; its text shows at once on return.
  hidden: () => AppState.currentState === 'background',
};

/**
 * Framework-free so the schedule is unit-tested with a manual clock.
 * `show(text, streaming)` receives every render; `streaming: false` is the
 * one final call once the text is complete and its last word has faded in.
 *
 * - `initial` shows at once.
 * - `push(text, true)` sets a new target. Text that does not extend the shown
 *   text (an edit, a revert) shows at once.
 * - `push(text, false)` ends the stream. The rest drains at the faster end
 *   rate and lands in full, so no text is dropped. A value that was never
 *   streamed shows at once.
 */
export function createStreamPacer(
  show: (text: string, streaming: boolean) => void,
  initial: string,
  clock: PacerClock = defaultClock,
) {
  let target = initial;
  let shown = initial;
  let active = false;
  let streamed = false;
  let settled = true;
  let rate = 0;
  let budget = 0;
  let lastFrameAt = 0;
  let lastCommitAt = -Infinity;
  let drainedAt = 0;
  let frame: unknown = null;
  /** (time, received length) per growth, oldest first, inside `ARRIVAL_WINDOW_MS`. */
  const arrivals: { at: number; len: number }[] = [];

  const emit = (text: string, streaming: boolean) => {
    shown = text;
    settled = !streaming;
    show(text, streaming);
  };
  const stop = () => {
    if (frame !== null) clock.cancelFrame(frame as never);
    frame = null;
  };
  /** Nothing more to reveal right now: the rest is a word still arriving. */
  const parked = () => active && revealCut(target, shown.length, Infinity, false) <= shown.length;

  /** Arrival speed (chars/s) and the largest gap between two chunks (ms). */
  const arrivalStats = (now: number) => {
    while (arrivals.length > 0 && now - arrivals[0].at > ARRIVAL_WINDOW_MS) arrivals.shift();
    if (arrivals.length < 2) return { cps: 0, maxGap: MIN_RESERVE_MS };
    const first = arrivals[0];
    let maxGap = now - arrivals[arrivals.length - 1].at;
    for (let i = 1; i < arrivals.length; i++) maxGap = Math.max(maxGap, arrivals[i].at - arrivals[i - 1].at);
    const cps = ((target.length - first.len) * 1000) / Math.max(now - first.at, 1);
    return { cps, maxGap };
  };

  const tick = () => {
    frame = null;
    const now = clock.now();
    const dt = Math.min(now - lastFrameAt, MAX_FRAME_MS);
    lastFrameAt = now;

    if (shown === target) {
      if (active || settled) return;
      // The last word is still fading in: settle once it has.
      if (now - drainedAt >= STREAM_FADE_MS) return emit(target, false);
      frame = clock.requestFrame(tick);
      return;
    }

    const backlog = target.length - shown.length;
    let desired: number;
    if (active) {
      const { cps, maxGap } = arrivalStats(now);
      const reserve = (cps * Math.min(MAX_RESERVE_MS, Math.max(MIN_RESERVE_MS, maxGap * 1.2))) / 1000;
      desired = Math.max(STREAM_MIN_CPS, cps + ((backlog - reserve) * 1000) / CORRECTION_MS);
      rate += (desired - rate) * Math.min(1, dt / RATE_SMOOTHING_MS);
    } else {
      desired = Math.max(STREAM_MIN_CPS, (backlog * 1000) / STREAM_END_LAG_MS);
      rate = Math.max(rate, desired);
    }
    // Unspent budget is capped at one long frame's worth, so a wait for a
    // word to finish arriving does not bank a burst for afterwards.
    budget = Math.min(budget + (rate * dt) / 1000, (rate * MAX_FRAME_MS) / 1000);

    if (now - lastCommitAt >= STREAM_COMMIT_MS) {
      const cut = revealCut(target, shown.length, budget, !active);
      if (cut > shown.length) {
        budget -= cut - shown.length;
        lastCommitAt = now;
        emit(target.slice(0, cut), true);
        if (shown === target) drainedAt = now;
      }
    }
    if (!parked()) frame = clock.requestFrame(tick);
  };

  const schedule = () => {
    if (frame !== null) return;
    // A restart from rest begins with an empty budget and a fresh frame clock.
    lastFrameAt = clock.now();
    budget = 0;
    frame = clock.requestFrame(tick);
  };

  return {
    push(text: string, isActive: boolean) {
      const grew = text.length > target.length;
      target = text;
      active = isActive;
      if (isActive) streamed = true;
      if (isActive && grew) arrivals.push({ at: clock.now(), len: text.length });
      if (!text.startsWith(shown) || !streamed || clock.hidden()) {
        stop();
        if (text !== shown || settled === isActive) emit(text, isActive);
        return;
      }
      if (text === shown) {
        // Fully revealed. If the stream just ended, let the last word fade first.
        if (!isActive && !settled && frame === null) {
          drainedAt = clock.now();
          schedule();
        }
        return;
      }
      if (!parked()) schedule();
    },
    dispose: stop,
  };
}

/**
 * `value`, revealed at a steady pace while `active`, and whether the message
 * must still render as streaming. That stays true after `active` turns false
 * while the last of the text drains and its last word fades in (a few
 * hundred ms), so the switch to the settled render changes nothing visible.
 */
export function useStreamingCadence(
  rawValue: string,
  active: boolean,
): { text: string; streaming: boolean } {
  // A part's text is typed as a string but arrives from the wire; anything
  // else renders as its string form instead of throwing in `startsWith`.
  const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
  const [state, setState] = useState(() => ({
    text: active && value.length <= RETYPE_MAX_CHARS ? '' : value,
    streaming: active,
  }));
  const pacerRef = useRef<ReturnType<typeof createStreamPacer> | null>(null);
  if (pacerRef.current === null) {
    pacerRef.current = createStreamPacer(
      (text, streaming) => setState({ text, streaming }),
      state.text,
    );
  }

  useEffect(() => {
    pacerRef.current?.push(value, active);
  }, [value, active]);
  useEffect(() => () => pacerRef.current?.dispose(), []);

  const text = value.startsWith(state.text) ? state.text : value;
  return { text, streaming: active || state.streaming || text !== value };
}

/**
 * A table is plain text until its separator row (`|---|`) arrives: a header
 * row on its own renders as a paragraph of pipes, then jumps into a table.
 * While streaming, a trailing header row (and a half-written separator) is
 * held back until the separator is complete, so the table appears as a table.
 */
export function holdBackTableHeader(text: string): string {
  if (!text.includes('|')) return text;
  const lines = text.split('\n');
  let end = lines.length;
  if (lines[end - 1]?.trim() === '') end--;
  const isRow = (line: string | undefined) => line?.trimStart().startsWith('|') ?? false;
  const last = lines[end - 1];
  if (!isRow(last)) return text;
  // `| a | b |` with no table line above it: a header still waiting for its separator.
  if (!isRow(lines[end - 2])) return lines.slice(0, end - 1).join('\n');
  // A separator still being written under a header that starts the table.
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').length;
  const header = lines[end - 2];
  const separatorDone = last.trim().endsWith('|') && cells(last) >= cells(header);
  if (/^\s*\|[\s|:-]*$/.test(last) && !isRow(lines[end - 3]) && !separatorDone) {
    return lines.slice(0, end - 2).join('\n');
  }
  return text;
}
