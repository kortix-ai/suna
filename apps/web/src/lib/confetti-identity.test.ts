import { PROJECT_GLYPH_NAMES, chalkColors } from '@kortix/shared';
import { describe, expect, test } from 'bun:test';

import { confettiChalkSeed, confettiInitial, resolveConfettiFace } from './confetti-identity';

describe('resolveConfettiFace precedence', () => {
  test('a glyph beats an emoji and a label — the same order EntityAvatar draws', () => {
    expect(
      resolveConfettiFace({
        glyph: { name: 'Heart', color: 'red' },
        emoji: '🐢',
        label: 'Turtle Shop',
      }),
    ).toEqual({ kind: 'glyph', name: 'Heart', color: 'red' });
  });

  test('an emoji beats a label', () => {
    expect(resolveConfettiFace({ emoji: '🐢', label: 'Turtle Shop' })).toEqual({
      kind: 'emoji',
      emoji: '🐢',
    });
  });

  test('neither falls through to the initial', () => {
    expect(resolveConfettiFace({ label: 'Turtle Shop' })).toMatchObject({
      kind: 'initial',
      initial: 'T',
    });
  });
});

describe('resolveConfettiFace fall-through', () => {
  // Stale cached data: a project whose `icon_glyph.name` outlived a catalogue
  // that shrank. The server rejects unknown names, so this is the only way one
  // reaches the client — and there the next face down is the right answer.
  test('an unknown glyph name falls through to the emoji, not to a blank particle', () => {
    expect(
      resolveConfettiFace({
        glyph: { name: 'NotAGlyphInTheCatalogue', color: 'red' },
        emoji: '🐢',
        label: 'Turtle Shop',
      }),
    ).toEqual({ kind: 'emoji', emoji: '🐢' });
  });

  test('an unknown glyph with no emoji falls all the way to the initial', () => {
    expect(
      resolveConfettiFace({ glyph: { name: 'Nope', color: 'red' }, label: 'Turtle Shop' }),
    ).toMatchObject({ kind: 'initial', initial: 'T' });
  });

  test('every name in the shipped catalogue resolves as a glyph', () => {
    const unresolved = PROJECT_GLYPH_NAMES.filter(
      (name) => resolveConfettiFace({ glyph: { name, color: 'grey' } }).kind !== 'glyph',
    );

    expect(unresolved).toEqual([]);
  });
});

describe('emoji normalisation', () => {
  // A plain loop, not `test.each`: `@types/bun` does not declare `each`, and
  // the three files that use it are the whole of `apps/web`'s known tsc error
  // budget (CLAUDE.md). A fourth would make that budget a moving target.
  for (const emoji of [null, undefined, '', '   '] as const) {
    test(`${JSON.stringify(emoji)} is "no emoji" and falls to the initial`, () => {
      expect(resolveConfettiFace({ emoji, label: 'Kortix' })).toMatchObject({
        kind: 'initial',
        initial: 'K',
      });
    });
  }

  test('a padded emoji is trimmed rather than measured with its padding', () => {
    expect(resolveConfettiFace({ emoji: ' 🚀 ' })).toEqual({ kind: 'emoji', emoji: '🚀' });
  });
});

describe('confettiInitial', () => {
  test('uppercases the first character', () => {
    expect(confettiInitial('turtle shop')).toBe('T');
  });

  test('falls back to ? for an empty or absent label', () => {
    expect(confettiInitial('   ')).toBe('?');
    expect(confettiInitial(null)).toBe('?');
  });

  // charAt(0) returns one UTF-16 code unit, so an astral first character comes
  // back as half a surrogate pair and renders as a replacement glyph — in
  // EVERY particle, not just once.
  test('takes a whole astral grapheme, not half a surrogate pair', () => {
    expect(confettiInitial('𝕂ortix')).toBe('𝕂');
    expect(confettiInitial('𝕂ortix')).toHaveLength(2);
  });
});

describe('confettiChalkSeed', () => {
  // The tile hashes the LABEL. Seeding on the letter would throw the right
  // letter in the wrong colour, beside an avatar in the right one.
  test('hashes the whole label, not the initial', () => {
    expect(confettiChalkSeed('Turtle Shop', 'T')).toBe('Turtle Shop');
    expect(chalkColors(confettiChalkSeed('Turtle Shop', 'T'))).toEqual(chalkColors('Turtle Shop'));
    expect(chalkColors(confettiChalkSeed('Turtle Shop', 'T'))).not.toEqual(chalkColors('T'));
  });

  test('trims, so a padded label and a clean one are the same colour', () => {
    expect(confettiChalkSeed('  Kortix  ', 'K')).toBe('Kortix');
  });

  // Deliberately reproduces entity-avatar.tsx's `${label?.trim()}` quirk — an
  // absent label stringifies to the truthy word "undefined". Copied so the
  // particles match the tile; see confettiChalkSeed's own doc comment.
  // BOTH null and undefined land on the word "undefined": `label?.trim()`
  // short-circuits to `undefined` for either, and the template literal then
  // stringifies that. So a null-named project and an unnamed one are the same
  // colour, in the tile and in the confetti alike.
  test('reproduces the avatar tile’s absent-label seed exactly', () => {
    expect(confettiChalkSeed(undefined, '?')).toBe('undefined');
    expect(confettiChalkSeed(null, '?')).toBe('undefined');
  });

  test('an EMPTY but present label is the only case that falls to the initial', () => {
    expect(confettiChalkSeed('   ', '?')).toBe('?');
  });
});
