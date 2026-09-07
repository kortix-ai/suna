import { describe, expect, test } from 'bun:test';

import { templateVisual } from './template-visual';

/**
 * The slug→glyph heuristic is only as good as its ORDER: the list is
 * first-match-wins, so a broad pattern placed above a specific one silently
 * eats it. That is not visible in a diff, and it is very visible on the page —
 * the banner renders the glyph at `size-9`, so a wrong pick is the largest
 * thing on the card.
 */
describe('templateVisual', () => {
  test('a specific subject beats a broad one that also matches', () => {
    // `feedback-triage` matches BOTH /feedback/ and /triage/. It is feedback,
    // not an incident, so the feedback rule has to sit above the triage rule.
    expect(templateVisual('kortix-feedback-triage').Icon).toBe(
      templateVisual('customer-feedback').Icon,
    );
    expect(templateVisual('kortix-feedback-triage').Icon).not.toBe(
      templateVisual('error-triage').Icon,
    );
  });

  test('every catalog slug today resolves to a distinct-enough glyph', () => {
    const slugs = [
      'sre-oncall',
      'kortix-candidate-screening',
      'kortix-slow-query-optimizer',
      'kortix-feedback-triage',
      'ads-ab-testing-lab',
      'kortix-competitor-watch',
    ];
    // Six templates, six different glyphs — the point of the keyword table is
    // that a grid of cards does not read as one repeated icon.
    const icons = new Set(slugs.map((slug) => templateVisual(slug).Icon));
    expect(icons.size).toBe(slugs.length);
  });

  test('an unknown slug still gets a stable hue, glyph and banner', () => {
    const first = templateVisual('something-nobody-planned-for');
    const again = templateVisual('something-nobody-planned-for');
    expect(first).toEqual(again);
    expect(first.banner).toContain('from-kortix-');
    expect(first.color).toContain('text-kortix-');
  });

  test('the banner rides the same hue as the tile', () => {
    // One template, one hue, everywhere it appears — the card banner, the tile
    // behind its icon and the icon itself must never disagree.
    for (const slug of ['sre-oncall', 'ads-ab-testing-lab', 'anything-else']) {
      const { color, bgColor, banner } = templateVisual(slug);
      const hue = color.replace('text-kortix-', '');
      expect(bgColor).toBe(`bg-kortix-${hue}/15`);
      expect(banner).toBe(`from-kortix-${hue}/30 via-kortix-${hue}/5`);
    }
  });
});
