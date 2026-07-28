/**
 * The rotating capability line in the empty-state showcase.
 *
 * Each phrase reads as one sentence — "Kortix <verb> <what it does>" — with the
 * verb carrying an icon, so the graphic teaches what the product does instead of
 * decorating the page. Keep them concrete and true: every line here maps to
 * something Kortix actually does today.
 */

import {
  BarChart3,
  CalendarClock,
  Code2,
  FileText,
  type LucideIcon,
  Plug,
  Search,
} from 'lucide-react';

export interface ShowcasePhrase {
  id: string;
  icon: LucideIcon;
  /** The bolded verb, rendered beside the icon. */
  verb: string;
  /** The rest of the sentence, typed out after the verb. */
  rest: string;
}

export const SHOWCASE_PHRASES: ShowcasePhrase[] = [
  {
    id: 'research',
    icon: Search,
    verb: 'researches',
    rest: 'dozens of sources in parallel and turns the findings into a brief you can act on.',
  },
  {
    id: 'build',
    icon: Code2,
    verb: 'builds',
    rest: 'and ships websites, dashboards, and internal tools.',
  },
  {
    id: 'automate',
    icon: CalendarClock,
    verb: 'automates',
    rest: 'recurring work — lead research, follow-ups, and the weekly report.',
  },
  {
    id: 'integrate',
    icon: Plug,
    verb: 'connects',
    rest: 'the tools you already use, and acts inside them on your behalf.',
  },
  {
    id: 'analyze',
    icon: BarChart3,
    verb: 'analyses',
    rest: 'your spreadsheets and databases, and explains what actually changed.',
  },
  {
    id: 'draft',
    icon: FileText,
    verb: 'drafts',
    rest: 'contracts, decks, and documents with citations you can check.',
  },
];

export type TypingPhase = 'typing' | 'holding' | 'erasing';

export interface TypewriterState {
  phraseIndex: number;
  /** How many characters of `rest` are visible. */
  charCount: number;
  phase: TypingPhase;
  /** Ticks spent in the current hold. */
  heldTicks: number;
}

export const INITIAL_TYPEWRITER: TypewriterState = {
  phraseIndex: 0,
  charCount: 0,
  phase: 'typing',
  heldTicks: 0,
};

/** Ticks to dwell on a finished sentence before erasing it. */
export const HOLD_TICKS = 28;

/**
 * One frame of the typewriter, as a pure function so the timing rules are
 * testable without a clock.
 *
 * Erasing runs faster than typing (3 chars a tick) — a slow backspace of a long
 * sentence is the part that reads as waiting rather than motion.
 */
export function advanceTypewriter(
  state: TypewriterState,
  phrases: readonly ShowcasePhrase[] = SHOWCASE_PHRASES,
): TypewriterState {
  const phrase = phraseAt(state, phrases);
  if (!phrase) return state;
  const full = phrase.rest.length;

  if (state.phase === 'typing') {
    if (state.charCount >= full) return { ...state, phase: 'holding', heldTicks: 0 };
    return { ...state, charCount: Math.min(full, state.charCount + 1) };
  }

  if (state.phase === 'holding') {
    // Count the tick first, so exactly HOLD_TICKS ticks are spent holding.
    const held = state.heldTicks + 1;
    if (held >= HOLD_TICKS) return { ...state, phase: 'erasing', heldTicks: 0 };
    return { ...state, heldTicks: held };
  }

  // erasing
  if (state.charCount <= 0) {
    return {
      phraseIndex: (state.phraseIndex + 1) % phrases.length,
      charCount: 0,
      phase: 'typing',
      heldTicks: 0,
    };
  }
  return { ...state, charCount: Math.max(0, state.charCount - 3) };
}

/** The visible slice of the current phrase for a given state. */
export function visibleRest(
  state: TypewriterState,
  phrases: readonly ShowcasePhrase[] = SHOWCASE_PHRASES,
): string {
  const phrase = phraseAt(state, phrases);
  if (!phrase) return '';
  return phrase.rest.slice(0, Math.max(0, Math.min(phrase.rest.length, state.charCount)));
}

export function phraseAt(
  state: TypewriterState,
  phrases: readonly ShowcasePhrase[] = SHOWCASE_PHRASES,
): ShowcasePhrase | null {
  if (phrases.length === 0) return null;
  const index = ((state.phraseIndex % phrases.length) + phrases.length) % phrases.length;
  return phrases[index] ?? null;
}
