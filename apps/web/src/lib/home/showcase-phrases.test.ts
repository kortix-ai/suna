import { describe, expect, test } from 'bun:test';

import {
  HOLD_TICKS,
  INITIAL_TYPEWRITER,
  SHOWCASE_PHRASES,
  type ShowcasePhrase,
  type TypewriterState,
  advanceTypewriter,
  phraseAt,
  visibleRest,
} from './showcase-phrases';

const ONE: ShowcasePhrase[] = [
  { id: 'a', icon: SHOWCASE_PHRASES[0].icon, verb: 'does', rest: 'abcdef' },
];
const TWO: ShowcasePhrase[] = [
  ...ONE,
  { id: 'b', icon: SHOWCASE_PHRASES[0].icon, verb: 'also', rest: 'xy' },
];

function run(steps: number, phrases: ShowcasePhrase[], from = INITIAL_TYPEWRITER) {
  let s: TypewriterState = from;
  for (let i = 0; i < steps; i += 1) s = advanceTypewriter(s, phrases);
  return s;
}

describe('phrase content', () => {
  test('every shipped phrase has a verb, a body and an icon', () => {
    for (const p of SHOWCASE_PHRASES) {
      expect(p.verb.length).toBeGreaterThan(0);
      expect(p.rest.length).toBeGreaterThan(0);
      expect(p.icon).toBeDefined();
    }
  });

  test('ids are unique, so React keys cannot collide', () => {
    const ids = new Set(SHOWCASE_PHRASES.map((p) => p.id));
    expect(ids.size).toBe(SHOWCASE_PHRASES.length);
  });

  test('each sentence ends in a full stop', () => {
    for (const p of SHOWCASE_PHRASES) expect(p.rest.trim().endsWith('.')).toBe(true);
  });
});

describe('advanceTypewriter', () => {
  test('types one character per tick', () => {
    expect(run(3, ONE).charCount).toBe(3);
    expect(visibleRest(run(3, ONE), ONE)).toBe('abc');
  });

  test('never types past the end of the phrase', () => {
    const s = run(50, ONE);
    expect(s.charCount).toBeLessThanOrEqual(ONE[0].rest.length);
  });

  test('switches to holding once the sentence is complete', () => {
    const s = run(ONE[0].rest.length + 1, ONE);
    expect(s.phase).toBe('holding');
  });

  test('holds for HOLD_TICKS before erasing', () => {
    let s = run(ONE[0].rest.length + 1, ONE);
    expect(s.phase).toBe('holding');
    s = run(HOLD_TICKS, ONE, s);
    expect(s.phase).toBe('erasing');
  });

  test('erases faster than it types', () => {
    // length + 1 tick to flip into holding, then HOLD_TICKS to flip into erasing.
    const erasing = run(ONE[0].rest.length + 1 + HOLD_TICKS, ONE);
    expect(erasing.phase).toBe('erasing');
    const after = advanceTypewriter(erasing, ONE);
    expect(erasing.charCount - after.charCount).toBe(3);
  });

  test('advances to the next phrase after erasing', () => {
    const s = run(200, TWO);
    // 200 ticks is well past one full cycle of the 6-char phrase.
    expect(s.phraseIndex).toBeGreaterThan(0);
  });

  test('wraps back to the first phrase', () => {
    let s: TypewriterState = {
      phraseIndex: TWO.length - 1,
      charCount: 0,
      phase: 'erasing',
      heldTicks: 0,
    };
    s = advanceTypewriter(s, TWO);
    expect(s.phraseIndex).toBe(0);
  });

  test('is a pure function — the input state is not mutated', () => {
    const before: TypewriterState = { ...INITIAL_TYPEWRITER };
    advanceTypewriter(before, ONE);
    expect(before).toEqual(INITIAL_TYPEWRITER);
  });

  test('an empty phrase list cannot crash or advance', () => {
    const s = advanceTypewriter(INITIAL_TYPEWRITER, []);
    expect(s).toEqual(INITIAL_TYPEWRITER);
    expect(visibleRest(INITIAL_TYPEWRITER, [])).toBe('');
    expect(phraseAt(INITIAL_TYPEWRITER, [])).toBeNull();
  });

  test('never produces a negative char count', () => {
    let s: TypewriterState = { phraseIndex: 0, charCount: 2, phase: 'erasing', heldTicks: 0 };
    s = advanceTypewriter(s, ONE);
    expect(s.charCount).toBeGreaterThanOrEqual(0);
  });
});

describe('visibleRest', () => {
  test('clamps a char count beyond the phrase length', () => {
    const s: TypewriterState = { phraseIndex: 0, charCount: 999, phase: 'typing', heldTicks: 0 };
    expect(visibleRest(s, ONE)).toBe('abcdef');
  });

  test('an out-of-range phrase index wraps rather than throwing', () => {
    const s: TypewriterState = { phraseIndex: 99, charCount: 2, phase: 'typing', heldTicks: 0 };
    expect(visibleRest(s, TWO)).toBe(TWO[99 % TWO.length].rest.slice(0, 2));
  });
});
