import { describe, expect, test } from 'bun:test';

import {
  buildFieldSvg,
  buildTokens,
  computeGrid,
  OPACITY_BY_KIND,
  PROPER,
  shuffleWithSpaces,
  SOURCE,
  svgEscape,
  svgToDataUri,
  type Token,
} from './kortix-letter-field.cells';

describe('buildTokens', () => {
  test('is deterministic for a fixed seed (no hydration mismatch)', () => {
    expect(buildTokens(100, 3382)).toEqual(buildTokens(100, 3382));
  });

  test('produces exactly the requested count', () => {
    expect(buildTokens(50, 1)).toHaveLength(50);
    expect(buildTokens(0, 1)).toHaveLength(0);
  });

  test('every token is one of the three kinds', () => {
    const tokens = buildTokens(500, 42);
    for (const t of tokens) {
      expect(['scrambled', 'proper', 'kortix']).toContain(t.kind);
    }
  });

  test('scrambled tokens are permutations of the source letters', () => {
    const scrambled = buildTokens(200, 7).filter((t) => t.kind === 'scrambled');
    expect(scrambled.length).toBeGreaterThan(0);
    for (const t of scrambled) {
      // Same multiset of characters as SOURCE (ignoring spaces), just reordered.
      const norm = t.text.replace(/\s/g, '');
      expect(norm.split('').sort().join('')).toBe(SOURCE.split('').sort().join(''));
    }
  });

  test('kortix + proper tokens render the expected brand text', () => {
    const tokens = buildTokens(2000, 99);
    expect(tokens.some((t) => t.kind === 'kortix' && t.text === 'k o r t i x')).toBe(true);
    expect(tokens.some((t) => t.kind === 'proper' && t.text === PROPER)).toBe(true);
  });
});

describe('shuffleWithSpaces', () => {
  test('preserves the character multiset (plus spaces)', () => {
    const rng = (() => {
      let a = 12345 >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const out = shuffleWithSpaces('abc', rng);
    expect(out.replace(/\s/g, '').split('').sort().join('')).toBe('abc');
  });
});

describe('computeGrid', () => {
  test('cols/rows are >= 1 even for a zero-size container', () => {
    const g = computeGrid(0, 0);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.rows).toBeGreaterThanOrEqual(1);
    expect(g.tokenCount).toBe(g.cols * g.rows);
  });

  test('wider viewports produce more (or equal) columns', () => {
    const small = computeGrid(400, 800);
    const wide = computeGrid(1600, 800);
    expect(wide.cols).toBeGreaterThanOrEqual(small.cols);
  });

  test('small viewport uses the small-screen font size + padding', () => {
    expect(computeGrid(400, 800).fontSize).toBe(8);
    expect(computeGrid(800, 800).fontSize).toBe(9);
    expect(computeGrid(1280, 800).fontSize).toBe(10);
  });

  test('cellWidth distributes the inner width across columns', () => {
    const g = computeGrid(1280, 800);
    const innerWidth = g.cellWidth * g.cols + 24 * 2 + 4 * (g.cols - 1);
    expect(Math.abs(innerWidth - 1280)).toBeLessThanOrEqual(2);
  });
});

describe('svgEscape', () => {
  test('escapes the XML metacharacters', () => {
    expect(svgEscape('a & <b> "c" \'d\'')).toBe('a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;');
  });
});

describe('buildFieldSvg', () => {
  const grid = computeGrid(1200, 800);
  const tokens: Token[] = buildTokens(grid.tokenCount, 3382);

  test('emits a single root <svg> with a <title> for accessibility', () => {
    const svg = buildFieldSvg(tokens, grid, 'rgb(20,20,20)', false);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<title>dosco</title>');
    expect(svg.match(/<svg/g)?.length).toBe(1);
  });

  test('renders one <text> element per token', () => {
    const svg = buildFieldSvg(tokens, grid, 'rgb(20,20,20)', false);
    expect(svg.match(/<text /g)?.length).toBe(tokens.length);
  });

  test('uses the resolved foreground color as the fill', () => {
    const svg = buildFieldSvg(tokens, grid, 'rgb(12, 34, 56)', false);
    expect(svg).toContain('fill="rgb(12, 34, 56)"');
  });

  test('applies the dark-mode opacity set when isDark=true', () => {
    const light = buildFieldSvg(tokens, grid, 'black', false);
    const dark = buildFieldSvg(tokens, grid, 'white', true);
    expect(light).toContain(`fill-opacity="${OPACITY_BY_KIND.scrambled.light}"`);
    expect(dark).toContain(`fill-opacity="${OPACITY_BY_KIND.scrambled.dark}"`);
  });

  // The core SEO guarantee: the scrambled brand tokens DO appear inside the
  // SVG image (they're the visual), but the SVG is only ever consumed as a
  // CSS background-image data URI — never inlined as DOM text. This test pins
  // that the tokens are present in the image content (so the visual is
  // preserved) AND that the output is a single self-contained <svg> document
  // (so there is no stray DOM text path).
  test('contains the brand tokens inside the svg image content', () => {
    const svg = buildFieldSvg(tokens, grid, 'black', false);
    expect(svg).toContain('k o r t i x');
    expect(svg).toContain(SOURCE.split('').join(' '));
    // Self-contained: no external refs that would break as a data URI.
    expect(svg).not.toMatch(/xlink:href/);
    expect(svg).not.toMatch(/src=/);
  });
});

describe('svgToDataUri', () => {
  test('produces a valid CSS data:image/svg+xml URL with no raw metacharacters', () => {
    const svg = buildFieldSvg(buildTokens(20, 1), computeGrid(400, 200), 'black', false);
    const uri = svgToDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    // The encoded payload must not contain raw <, >, #, ", or newlines — those
    // break the data URI in a CSS url("...") context.
    const payload = uri.slice('data:image/svg+xml,'.length);
    expect(payload).not.toMatch(/[<>"#\n\r]/);
  });

  test('round-trips via decodeURIComponent back to the original SVG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>';
    expect(decodeURIComponent(svgToDataUri(svg).slice('data:image/svg+xml,'.length))).toBe(svg);
  });
});
