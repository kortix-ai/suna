import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EMOJI_HUES, type EmojiHue, emojiHue, emojiTint, emojiTintHover } from './emoji-tint';

const source = readFileSync(fileURLToPath(new URL('./emoji-tint.ts', import.meta.url)), 'utf8');

/**
 * Source with comments stripped. The file's own prose names the class strings
 * in order to explain why they are literals, so a "the literal is present"
 * check has to read code and not a comment that merely mentions it.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The six anchor strings, read out of the source rather than exported. */
const dominantStart = code.indexOf('const DOMINANT');
const dominantBlock = code.slice(dominantStart, code.indexOf('};', dominantStart));

const anchors = Object.fromEntries(
  EMOJI_HUES.map((hue) => [hue, dominantBlock.match(new RegExp(`\\b${hue}:\\s*'([^']*)'`))?.[1]]),
) as Record<EmojiHue, string | undefined>;

/** The same normalisation the module applies before it looks anything up. */
const stripModifiers = (text: string) =>
  text.replace(/[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, '');

/** Emoji that are deliberately NOT anchored — the hash fallback's whole input. */
const UNANCHORED = [
  '🚀',
  '🤖',
  '📊',
  '🔧',
  '🎯',
  '🧠',
  '🗂️',
  '🎧',
  '🛠️',
  '📝',
  '🧭',
  '⚙️',
  '🪄',
  '🔍',
  '🏗️',
  '🧱',
  '📡',
  '🎬',
  '🗝️',
  '🧵',
  '🪝',
  '🧮',
  '📎',
  '🎲',
  '🥁',
  '🛰️',
  '🧳',
  '🪞',
  '🗳️',
  '🎹',
];

describe('emoji-tint — the anchor table', () => {
  test('every anchor string was actually read out of the source', () => {
    // Guard the guards. Every assertion below walks `anchors`, and a rename of
    // the DOMINANT record would leave them all iterating `undefined` — which
    // `.toBe(0)`-style checks would pass rather than fail.
    expect(dominantStart).toBeGreaterThan(-1);
    for (const hue of EMOJI_HUES) {
      expect(typeof anchors[hue]).toBe('string');
      expect(anchors[hue]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('each anchor is one code point after normalisation', () => {
    // The table is read with `[...string]`, which iterates CODE POINTS. That is
    // only equivalent to "one entry per emoji" while every anchor is a single
    // code point plus an optional variation selector. A ZWJ sequence or a flag
    // slipped into one of these strings would silently register its halves as
    // separate anchors — '🏳️‍🌈' would anchor the white flag AND the rainbow.
    for (const hue of EMOJI_HUES) {
      for (const glyph of [...stripModifiers(anchors[hue] ?? '')]) {
        expect([...glyph]).toHaveLength(1);
        expect(glyph.codePointAt(0)).toBeGreaterThan(0x1000);
      }
    }
  });

  test('no emoji is anchored to two hues', () => {
    // A duplicate resolves to whichever hue the Map wrote last, so the mapping
    // would be decided by the order of EMOJI_HUES rather than by the table —
    // and moving one line would silently repaint an emoji.
    const seen = new Map<string, EmojiHue>();

    for (const hue of EMOJI_HUES) {
      for (const glyph of [...stripModifiers(anchors[hue] ?? '')]) {
        expect(seen.get(glyph) ?? hue).toBe(hue);
        seen.set(glyph, hue);
      }
    }

    // …and the scan has to have seen a real table, or the loop above is vacuous.
    expect(seen.size).toBeGreaterThan(60);
  });

  test('the loud emoji land on the hue their glyph actually is', () => {
    // The table's whole reason to exist: these glyphs are one colour in every
    // vendor font, so a hash-picked ring on them reads as a mistake rather than
    // as a choice. One representative per hue, plus the six colour swatches
    // that have no interpretation at all.
    expect(emojiHue('🌿')).toBe('green');
    expect(emojiHue('🔥')).toBe('amber');
    expect(emojiHue('💧')).toBe('blue');
    expect(emojiHue('🍎')).toBe('red');
    expect(emojiHue('🍇')).toBe('violet');
    expect(emojiHue('🧊')).toBe('teal');

    expect(emojiHue('🔴')).toBe('red');
    expect(emojiHue('🟠')).toBe('amber');
    expect(emojiHue('🟢')).toBe('green');
    expect(emojiHue('🔵')).toBe('blue');
    expect(emojiHue('🟣')).toBe('violet');
  });

  test('an anchored emoji never falls through to the hash', () => {
    // The one mutation the spot-checks above cannot see: a lookup that misses
    // — a Map keyed on the un-normalised string, say — still returns a valid
    // hue for every input, so five of six anchors keep passing by luck.
    // Checking the WHOLE table is what makes that impossible.
    for (const hue of EMOJI_HUES) {
      for (const glyph of [...stripModifiers(anchors[hue] ?? '')]) {
        expect(emojiHue(glyph)).toBe(hue);
      }
    }
  });
});

describe('emoji-tint — the hash fallback', () => {
  test('an unanchored emoji still gets one of the six hues', () => {
    for (const emoji of UNANCHORED) {
      expect(EMOJI_HUES).toContain(emojiHue(emoji));
    }
  });

  test('the same emoji gets the same hue every time it is asked', () => {
    // The guarantee the whole feature rests on: a project keeps one colour
    // across the card, the picker trigger and the sidebar row, which are three
    // separate renders in three separate trees. Anything non-deterministic —
    // Math.random, a counter, Date — makes a project change colour on reload.
    for (const emoji of [...UNANCHORED, '🌿', '🔥']) {
      const first = emojiHue(emoji);
      for (let i = 0; i < 5; i++) expect(emojiHue(emoji)).toBe(first);
    }
  });

  test('the fallback spreads across all six hues, not onto one', () => {
    // A hash that collapsed — `% 1`, a constant, a seed that ignores its input
    // — satisfies every other test in this file while painting every
    // unanchored project the same colour. Thirty emoji is a small sample, so
    // this asserts all six appear rather than any particular balance.
    const hues = new Set(UNANCHORED.map(emojiHue));

    expect([...hues].sort()).toEqual([...EMOJI_HUES].sort());
  });

  test('different emoji do not all collapse onto one hue', () => {
    // Guards the guard above against a sample that happens to be well spread
    // for the wrong reason: two emoji one code point apart must be able to
    // differ, which a hash that only reads the string's LENGTH cannot do.
    expect(emojiHue('🚀')).not.toBe(emojiHue('🛰️'));
  });
});

describe('emoji-tint — normalisation', () => {
  test('a variation selector does not change the hue', () => {
    // Emoji reach this function from three places — the picker's own
    // onEmojiSelect, a project row loaded from the API, and a value typed into
    // the DB by an earlier client — and they do not agree on U+FE0F. '❤️' and
    // '❤' are the same icon and must be the same colour.
    expect(emojiHue('❤️')).toBe(emojiHue('❤'));
    expect(emojiHue('❤️')).toBe('red');
  });

  test('a skin tone does not change the hue', () => {
    // frimousse ships a skin-tone selector, so the same base emoji arrives in
    // five forms. Without the strip they are five unrelated hash inputs and the
    // same gesture picks five different colours.
    const tones = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];

    expect(new Set(tones.map(emojiHue)).size).toBe(1);
  });

  test('normalisation does not swallow the emoji itself', () => {
    // A strip that was too greedy — dropping every non-BMP code point, say —
    // would map every input to '' and hand the whole app one hue, while the
    // two tests above still passed.
    expect(new Set(['🚀', '🌿', '🔥', '💧', '🍇', '🧊', '🍎'].map(emojiHue)).size).toBeGreaterThan(
      1,
    );
  });

  test('an empty string still returns a hue rather than throwing', () => {
    // Callers gate on truthiness before they call this, but the function is
    // exported and a `?? ''` upstream must not crash a render.
    expect(EMOJI_HUES).toContain(emojiHue(''));
  });
});

describe('emoji-tint — the classes it hands out', () => {
  test('each hue gets its own paired fill and ring', () => {
    for (const hue of EMOJI_HUES) {
      const tint = emojiTint(anchorFor(hue));

      expect(tint).toContain(`bg-emoji-fill-${hue}`);
      expect(tint).toContain(`inset-ring-emoji-ring-${hue}`);
    }
  });

  test('the ring has a width, or the colour draws nothing', () => {
    // `inset-ring-emoji-ring-red` is a COLOUR utility. On its own Tailwind
    // emits `--tw-inset-ring-color` with no shadow to colour, so the ring — the
    // half of the treatment that carries the contrast — is simply absent.
    for (const hue of EMOJI_HUES) {
      expect(emojiTint(anchorFor(hue)).split(/\s+/)).toContain('inset-ring-1');
    }
  });

  test('the tint cancels the border it replaces', () => {
    // Both hosts bring a 1px border of their own — EntityAvatar's base class
    // list and Button's `outline` variant. Left standing, that neutral border
    // sits OUTSIDE the inset ring and the tile reads as a double edge with a
    // grey outer line, which is not what the picker cell looks like.
    for (const hue of EMOJI_HUES) {
      expect(emojiTint(anchorFor(hue)).split(/\s+/)).toContain('border-0');
    }
  });

  test('the hover class holds the resting fill of the SAME hue', () => {
    // Button's `outline` variant carries `hover:bg-foreground/5`, which is a
    // background-color at higher specificity than the resting tint: hovering
    // the trigger would wipe the tint to a neutral wash. The hold cancels that
    // — and it has to name the same hue, or hovering repaints the trigger.
    for (const hue of EMOJI_HUES) {
      expect(emojiTintHover(anchorFor(hue))).toBe(`hover:bg-emoji-fill-${hue}`);
    }
  });

  test('two emoji of different hues get different classes', () => {
    // The single mutation that satisfies every "contains" check above while
    // shipping one colour for the whole app: a record whose six entries are the
    // same string.
    expect(emojiTint('🌿')).not.toBe(emojiTint('🔥'));
    expect(new Set(EMOJI_HUES.map((hue) => emojiTint(anchorFor(hue)))).size).toBe(6);
  });

  test('every class name appears in the source as a LITERAL', () => {
    // Tailwind v4 builds its stylesheet by scanning source TEXT. A class
    // assembled with a template literal or a .map() produces no CSS at all, the
    // tints silently never paint, and every other test in this file still
    // passes because they only ever compare strings. This has already happened
    // once on this feature.
    for (const hue of EMOJI_HUES) {
      expect(code).toContain(`bg-emoji-fill-${hue}`);
      expect(code).toContain(`inset-ring-emoji-ring-${hue}`);
      expect(code).toContain(`hover:bg-emoji-fill-${hue}`);
    }

    // …and no interpolation may build one, which is the shape that would make
    // the literals above disappear.
    expect(code).not.toMatch(/emoji-(?:fill|ring)-\$\{/);
    expect(code).not.toMatch(/['"`]\s*\+\s*hue/);
    expect(code).not.toMatch(/emoji-(?:fill|ring)-['"`]\s*\+/);
  });

  test('the tokens it names are the ones globals.css actually defines', () => {
    // The class strings are literals in this file and the tokens are literals
    // in another; nothing else ties them together. A typo'd hue emits a class
    // Tailwind cannot resolve, which fails silently as "no fill, no ring".
    const globals = readFileSync(
      fileURLToPath(new URL('../../app/globals.css', import.meta.url)),
      'utf8',
    );

    for (const hue of EMOJI_HUES) {
      expect(globals).toContain(`--color-emoji-fill-${hue}:`);
      expect(globals).toContain(`--color-emoji-ring-${hue}:`);
    }
  });
});

/** One anchored emoji per hue, taken from the table itself. */
function anchorFor(hue: EmojiHue): string {
  return [...stripModifiers(anchors[hue] ?? '')][0] ?? '';
}
