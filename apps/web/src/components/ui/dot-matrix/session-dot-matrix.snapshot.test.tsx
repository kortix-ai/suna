import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DOT_MATRIX_CATALOG } from './session-dot-matrix';

/**
 * Characterization pins for the dotm catalog (KRTX-654, phase 1 of
 * code-spec:dedupe-dotm-variant-shell).
 *
 * Phases 2-3 of the spec convert the 20 dotm-square-* and 15 dotm-circular-*
 * files onto one shared 5x5 factory. These tests pin today's behavior so the
 * mechanical conversion cannot change what renders:
 *
 * 1. Every catalog entry is server-rendered with renderToStaticMarkup at its
 *    default size and at size=14. The snapshot holds the root class/style and
 *    one token per dot: the dot's class plus every style declaration except
 *    the invariant ones (see INVARIANT_STYLE_KEYS). Every catalog variant
 *    renders the full pattern, so pattern-inactive dots never appear; the
 *    circular mask lives in the resolvers.
 * 2. One continuous-cycle (dotm-circular-1) and one stepped-cycle
 *    (dotm-square-14) variant's resolver opacities are pinned over sampled
 *    cycle values. The resolver is not reachable from outside its component,
 *    so the cycle hooks are stubbed to feed it sampled inputs; the snapshots
 *    were generated at the pre-conversion code. A snapshot diff after a
 *    conversion phase means the conversion changed rendering.
 */

const DOT_SPAN = /<span aria-hidden="true" class="([^"]*)" style="([^"]*)"/g;
const ROOT_DIV = /<div role="status" aria-live="polite" aria-label="[^"]*" class="([^"]*)" style="([^"]*)"/;

/**
 * Style declarations that carry nothing variant-specific: positional values
 * (pure functions of row/col/size/dotSize) and the bloom level, which is 0
 * for every catalog variant (none passes bloom/halo; the root token still
 * pins the root's --dmx-halo-level).
 */
const INVARIANT_STYLE_KEYS = new Set([
  'width',
  'height',
  '--dmx-distance',
  '--dmx-row',
  '--dmx-col',
  '--dmx-x',
  '--dmx-y',
  '--dmx-angle',
  '--dmx-radius',
  '--dmx-manhattan',
  '--dmx-bloom-level',
]);

function compactVars(style: string): string {
  return style
    .split(';')
    .filter((part) => part && !INVARIANT_STYLE_KEYS.has(part.slice(0, part.indexOf(':'))))
    .join(';');
}

/** One token per dot: "<class>|<style vars minus the positional ones>". */
function dotTokens(html: string): string[] {
  const tokens: string[] = [];
  for (const match of html.matchAll(DOT_SPAN)) {
    tokens.push(`${match[1]}|${compactVars(match[2]!)}`);
  }
  return tokens;
}

/** Opacity declarations in dot order; dots the resolver leaves unstyled have none. */
function dotOpacities(tokens: string[]): (string | undefined)[] {
  return tokens.map((token) => /opacity:([^;]+)/.exec(token)?.[1]);
}

function rootToken(html: string): string {
  const match = ROOT_DIV.exec(html);
  return match ? `${match[1]}|${match[2]}` : 'no root div';
}

describe('dotm catalog markup characterization', () => {
  const SIZES = ['default', 14] as const;

  for (const entry of DOT_MATRIX_CATALOG) {
    for (const size of SIZES) {
      test(`markup pin ${entry.name} ${size === 'default' ? 'default' : 'size=14'}`, () => {
        const html =
          size === 'default'
            ? renderToStaticMarkup(<entry.Component />)
            : renderToStaticMarkup(<entry.Component size={14} />);
        expect({ root: rootToken(html), dots: dotTokens(html) }).toMatchSnapshot();
      });
    }
  }

  test('the extractor sees every dot (5x5 renders 25, 3x3 renders 9)', () => {
    for (const entry of DOT_MATRIX_CATALOG) {
      const html = renderToStaticMarkup(<entry.Component />);
      expect(dotTokens(html)).toHaveLength(entry.family === '3x3' ? 9 : 25);
    }
  });
});

// Captured before any mock so afterAll can restore the real hooks.
const realHooks = await import('@/lib/dotmatrix-hooks');

describe('dotm resolver characterization (sampled cycle values)', () => {
  const sampled = { cyclePhase: 0, steppedStep: 0, reducedMotion: false };
  let DotmCircular1!: (typeof import('./dotm-circular-1'))['DotmCircular1'];
  let DotmSquare14!: (typeof import('./dotm-square-14'))['DotmSquare14'];

  beforeAll(async () => {
    mock.module('@/lib/dotmatrix-hooks', () => ({
      ...realHooks,
      useCyclePhase: () => sampled.cyclePhase,
      useSteppedCycle: () => sampled.steppedStep,
      usePrefersReducedMotion: () => sampled.reducedMotion,
    }));
    ({ DotmCircular1 } = await import('./dotm-circular-1'));
    ({ DotmSquare14 } = await import('./dotm-square-14'));
  });

  afterAll(() => {
    mock.module('@/lib/dotmatrix-hooks', () => ({ ...realHooks }));
  });

  test('dotm-circular-1 resolver opacities over sampled animPhase values', () => {
    // animPhase ∈ [0, 1): the continuous cycle hook's output domain.
    const samples = [0, 0.13, 0.37, 0.5, 0.71, 0.89];
    const perSample = samples.map((phase) => {
      sampled.cyclePhase = phase;
      const dots = dotTokens(renderToStaticMarkup(<DotmCircular1 />));
      const opacities = dotOpacities(dots).filter((opacity) => opacity !== undefined);
      // The resolver's own circular mask leaves out the 4 corners, so 21 of
      // 25 dots get styled; it emits only its three opacity constants
      // (strand 1, near-strand 0.24, base 0.08).
      expect(opacities).toHaveLength(21);
      for (const opacity of new Set(opacities)) {
        expect(['0.08', '0.24', '1']).toContain(opacity);
      }
      return dots;
    });
    expect(perSample).toMatchSnapshot();
  });

  test('dotm-circular-1 reduced motion renders the idle (phase 0) mapping', () => {
    sampled.reducedMotion = true;
    sampled.cyclePhase = 0.37;
    const reduced = renderToStaticMarkup(<DotmCircular1 />);
    sampled.reducedMotion = false;
    sampled.cyclePhase = 0;
    const idle = renderToStaticMarkup(<DotmCircular1 />);
    sampled.cyclePhase = 0.5;
    const moving = renderToStaticMarkup(<DotmCircular1 />);
    expect(reduced).toEqual(idle);
    expect(reduced).not.toEqual(moving);
  });

  test('dotm-square-14 resolver opacities over sampled step values', () => {
    // FRAME_SEQUENCE = [0, 1, 2, 3, 2, 1]: a palindrome over 4 masks.
    const steps = [0, 1, 2, 3, 4, 5, 7];
    const perStep = steps.map((step) => {
      sampled.steppedStep = step;
      const dots = dotTokens(renderToStaticMarkup(<DotmSquare14 />));
      // The resolver styles every dot of the full pattern, each with the
      // variant's smooth opacity transition.
      for (const opacity of dotOpacities(dots)) {
        expect(opacity).toBeDefined();
      }
      for (const token of dots) {
        expect(token).toContain('transition:opacity 180ms cubic-bezier(0.4, 0, 0.2, 1)');
      }
      return dots;
    });
    // step 7 is out of range: the resolver falls back to mask 0 (step 0).
    expect(perStep[6]).toEqual(perStep[0]);
    // The palindrome: steps 4 and 5 re-render masks 2 and 1.
    expect(perStep[4]).toEqual(perStep[2]);
    expect(perStep[5]).toEqual(perStep[1]);
    // The four masks are pairwise distinct.
    const [s0, s1, s2, s3] = perStep;
    expect(new Set([s0, s1, s2, s3]).size).toBe(4);
    expect(perStep).toMatchSnapshot();
  });
});
