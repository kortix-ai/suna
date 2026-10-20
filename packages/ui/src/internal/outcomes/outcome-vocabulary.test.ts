import { describe, expect, test } from 'bun:test';

import { OUTCOME_TITLE_MAX, outcomeTint, truncateOutcomeTitle } from './outcome-vocabulary';

describe('outcomeTint', () => {
  // The tinted tile is where an outcome's colour lives — the status chip stays
  // neutral. Every value is a `kortix-*` brand token; a raw Tailwind palette
  // class here is a design-system violation, so the mapping is pinned.
  test('each tone maps to a kortix brand token, never a raw palette class', () => {
    for (const tone of ['success', 'warning', 'destructive', 'info'] as const) {
      const { bg, fg } = outcomeTint(tone);
      expect(bg).toContain('bg-kortix-');
      expect(fg).toContain('text-kortix-');
    }
  });

  test('waiting is orange, applied is green, failed is red, running is blue', () => {
    expect(outcomeTint('warning').bg).toBe('bg-kortix-orange/15');
    expect(outcomeTint('success').bg).toBe('bg-kortix-green/15');
    expect(outcomeTint('destructive').bg).toBe('bg-kortix-red/15');
    expect(outcomeTint('info').bg).toBe('bg-kortix-blue/15');
  });

  test('neutral is the only tone with no brand colour — it must stay muted', () => {
    expect(outcomeTint('neutral')).toEqual({
      // `bg-muted` needs no alpha: it is already a low-contrast semantic token,
      // not a brand colour being softened.
      bg: 'bg-muted',
      fg: 'text-muted-foreground/85',
      ring: 'ring-border/70',
    });
  });

  test('the ring and the glyph are TRANSLUCENT — the tile is quiet, not coloured', () => {
    // At full strength a 1px coloured ring is the highest-contrast element in
    // the row and pulls the eye before the title does. The glyph is decoration:
    // the status is written in words on the second line, so it reinforces a
    // fact the reader already has.
    for (const tone of ['success', 'warning', 'destructive', 'info'] as const) {
      const { bg, fg, ring } = outcomeTint(tone);
      expect(bg).toMatch(/\/15$/);
      expect(ring).toMatch(/\/40$/);
      expect(fg).toMatch(/\/85$/);
    }
  });

  test('no BRAND tone renders a fully opaque colour anywhere on the tile', () => {
    // The regression guard. Dropping any one alpha suffix puts a full-strength
    // brand colour back on a decorative element.
    //
    // `neutral` is excluded deliberately: its `bg-muted` is already a
    // low-contrast semantic token rather than a brand colour being softened, so
    // requiring an alpha there would be cargo-culting the rule past its reason.
    for (const tone of ['success', 'warning', 'destructive', 'info'] as const) {
      const { bg, fg, ring } = outcomeTint(tone);
      for (const value of [bg, fg, ring]) {
        expect(value).toContain('/');
      }
    }
  });

  test('every tone carries a ring, so the tile reads as an object at any tint', () => {
    for (const tone of ['success', 'warning', 'destructive', 'info'] as const) {
      expect(outcomeTint(tone).ring).toContain('ring-kortix-');
    }
    expect(outcomeTint('neutral').ring).toBe('ring-border/70');
  });
});

describe('truncateOutcomeTitle', () => {
  test('a short title is returned untouched', () => {
    expect(truncateOutcomeTitle('Change request #12')).toBe('Change request #12');
  });

  test('whitespace is collapsed so a newline cannot break the one-line row', () => {
    expect(truncateOutcomeTitle('Change\n  request  #12')).toBe('Change request #12');
  });

  test('a long title is cut with no space stranded before the ellipsis', () => {
    const long = 'A'.repeat(OUTCOME_TITLE_MAX) + ' tail';
    const cut = truncateOutcomeTitle(long);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain(' …');
    expect(cut.length).toBeLessThanOrEqual(OUTCOME_TITLE_MAX + 1);
  });

  test('the cut is by character count, not by word', () => {
    // Pinned deliberately. A single unbroken run has no word boundary to find,
    // and the visible truncation is the row's CSS `truncate` span — this
    // function only caps pathological input. Same rule as `bashRowTitle`.
    expect(truncateOutcomeTitle('Z'.repeat(70))).toBe(`${'Z'.repeat(OUTCOME_TITLE_MAX)}…`);
  });
});
