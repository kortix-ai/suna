/**
 * The conversation `SavedSessionSkeleton` draws while a session's saved copy
 * loads.
 *
 * Each session gets its own mix of turns: prompt widths, reply lengths, a
 * second paragraph, a tool row, a code block. The mix comes from the session
 * id, never `Math.random()`. The server render, the client render, and the
 * route's loading boundary each draw these rows, so they must draw the same
 * ones: otherwise hydration fails, or the rows jump when the page takes over
 * from the boundary.
 *
 * Every width is a literal class in this file, so Tailwind generates it.
 */

/** A prompt that fits on one line. */
export const PROMPT_WIDTHS = ['w-1/4', 'w-1/3', 'w-2/5', 'w-1/2', 'w-3/5'] as const;
/** A prompt that wraps to a second line is a wide one. */
export const TALL_PROMPT_WIDTHS = ['w-1/2', 'w-3/5', 'w-2/3'] as const;
/** The label beside a tool row's icon. */
export const TOOL_WIDTHS = ['w-1/5', 'w-1/4', 'w-1/3'] as const;
/** A reply line that wraps: close to the full measure. */
export const LINE_WIDTHS = ['w-full', 'w-11/12', 'w-5/6'] as const;
/** The line that ends a paragraph. */
export const LAST_LINE_WIDTHS = ['w-1/3', 'w-2/5', 'w-1/2', 'w-3/5', 'w-2/3', 'w-3/4'] as const;

/** Tailwind's `animate-pulse` period, which the `Skeleton` primitive runs. */
export const PULSE_PERIOD_MS = 2000;

export interface SkeletonLine {
  width: string;
  /** The row's place in the pulse wave; see `pulseDelayMs`. */
  phase: number;
}

export type SkeletonParagraph =
  | { kind: 'text'; lines: SkeletonLine[] }
  /** A code block or tool output: one tall block across the measure. */
  | { kind: 'block'; phase: number };

export interface SkeletonTurn {
  prompt: SkeletonLine & { tall: boolean };
  /** A tool the agent ran before it answered, or none. */
  tool: SkeletonLine | null;
  /** Text first, then at most one more paragraph or block. */
  reply: SkeletonParagraph[];
}

export interface SkeletonShape {
  turns: SkeletonTurn[];
  /** The composer's outline is the last row the pulse reaches. */
  composerPhase: number;
  /** Rows in the pulse wave, the composer included. */
  phases: number;
}

/** A deterministic stream in [0, 1): FNV-1a hashes the id into mulberry32. */
function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function savedSessionSkeletonShape(sessionId: string): SkeletonShape {
  const random = seededRandom(sessionId);
  const pick = <T>(options: readonly T[]): T =>
    options[Math.floor(random() * options.length)] as T;
  const chance = (probability: number) => random() < probability;
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  // Phases count the rows in reading order, so build the rows in that order.
  let phases = 0;
  const lines = (count: number): SkeletonLine[] =>
    Array.from({ length: count }, (_, index) => ({
      width: index === count - 1 ? pick(LAST_LINE_WIDTHS) : pick(LINE_WIDTHS),
      phase: phases++,
    }));

  const turns = Array.from({ length: chance(0.4) ? 4 : 3 }, (): SkeletonTurn => {
    const tall = chance(0.25);
    const prompt = { width: pick(tall ? TALL_PROMPT_WIDTHS : PROMPT_WIDTHS), tall, phase: phases++ };
    const tool = chance(0.45) ? { width: pick(TOOL_WIDTHS), phase: phases++ } : null;
    const reply: SkeletonParagraph[] = [{ kind: 'text', lines: lines(between(2, 4)) }];
    if (chance(0.4)) {
      reply.push(
        chance(0.35) ? { kind: 'block', phase: phases++ } : { kind: 'text', lines: lines(between(1, 4)) },
      );
    }
    return { prompt, tool, reply };
  });

  const composerPhase = phases++;
  return { turns, composerPhase, phases };
}

/**
 * The `animation-delay` that puts a row `phase` of `phases` on one pulse wave.
 *
 * Rows start their pulse evenly across one period, top to bottom, so a single
 * crest travels down the conversation once per period instead of every row
 * blinking together. The delay is negative: each row starts part-way through
 * its cycle, so every row is on screen and moving from the first frame.
 */
export function pulseDelayMs(phase: number, phases: number): number {
  const start = Math.round((phase * PULSE_PERIOD_MS) / Math.max(phases, 1));
  return start === 0 ? 0 : start - PULSE_PERIOD_MS;
}
