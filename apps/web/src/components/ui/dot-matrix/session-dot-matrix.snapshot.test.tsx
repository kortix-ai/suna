import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
 *    default size and at size=14. Each pin digests the root class/style and
 *    one token per dot: the dot's class plus every style declaration except
 *    the invariant ones (see INVARIANT_STYLE_KEYS). Every catalog variant
 *    renders the full pattern, so pattern-inactive dots never appear; the
 *    circular mask lives in the resolvers.
 * 2. One continuous-cycle (dotm-circular-1) and one stepped-cycle
 *    (dotm-square-14) variant's resolver opacities are pinned over sampled
 *    cycle values. The resolver is not reachable from outside its component,
 *    so the cycle hooks are stubbed to feed it sampled inputs.
 *
 * Every pin is a 16-hex SHA-256 digest over the pinned structure, so the
 * suite stays one file and a conversion phase updates ~20 short lines
 * instead of a megabyte snapshot. A digest mismatch after a conversion
 * phase means the conversion changed rendering: the failing test prints
 * expected and received digests — paste the received one into EXPECTED
 * only after confirming the new rendering is intended. The tokens are
 * deterministic, so the same code always produces the same digest.
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

/** One token per dot: "<class>|<style vars minus the invariant ones>". */
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

/** Stable 16-hex SHA-256 fingerprint of a pinned structure. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Expected digests, generated from the pre-conversion code at
 * 849413e86 (the dot-matrix surface is byte-identical to 7da0f79).
 * Keyed by "<variant>@<default|14>" and the two resolver tables.
 */
const EXPECTED: Record<string, string> = {
  'dotm-3x3-2@default': '3309062b89364257',
  'dotm-3x3-2@14': '3309062b89364257',
  'dotm-3x3-3@default': 'f1343800fe241381',
  'dotm-3x3-3@14': 'f1343800fe241381',
  'dotm-3x3-4@default': '57fd2bfb1c8aef25',
  'dotm-3x3-4@14': '57fd2bfb1c8aef25',
  'dotm-3x3-5@default': '6dd91cedbc838cb5',
  'dotm-3x3-5@14': '6dd91cedbc838cb5',
  'dotm-3x3-6@default': 'e8971adef0fa7e3e',
  'dotm-3x3-6@14': 'e8971adef0fa7e3e',
  'dotm-3x3-7@default': '431005fbf56b7567',
  'dotm-3x3-7@14': '431005fbf56b7567',
  'dotm-3x3-8@default': 'e24a89e25f2f811c',
  'dotm-3x3-8@14': 'e24a89e25f2f811c',
  'dotm-3x3-9@default': '81bd492de0a08e35',
  'dotm-3x3-9@14': '81bd492de0a08e35',
  'dotm-3x3-10@default': '30047f81caf54853',
  'dotm-3x3-10@14': '30047f81caf54853',
  'dotm-3x3-12@default': 'c74f4cc76e01b33e',
  'dotm-3x3-12@14': 'c74f4cc76e01b33e',
  'dotm-3x3-13@default': 'd7eb0891375eba92',
  'dotm-3x3-13@14': 'd7eb0891375eba92',
  'dotm-3x3-15@default': '0b298c7c800fb47b',
  'dotm-3x3-15@14': '0b298c7c800fb47b',
  'dotm-3x3-16@default': '17aff76747fd55e8',
  'dotm-3x3-16@14': '17aff76747fd55e8',
  'dotm-3x3-18@default': 'c7c00cc01b552cf2',
  'dotm-3x3-18@14': 'c7c00cc01b552cf2',
  'dotm-3x3-19@default': '6cc6303fcf634c85',
  'dotm-3x3-19@14': '6cc6303fcf634c85',
  'dotm-3x3-20@default': '40db1604eedbdf85',
  'dotm-3x3-20@14': '40db1604eedbdf85',
  'dotm-3x3-21@default': '368e34514c589110',
  'dotm-3x3-21@14': '368e34514c589110',
  'dotm-circular-1@default': '347d5dd40b3fcbb9',
  'dotm-circular-1@14': '182bac2df21a39d6',
  'dotm-circular-2@default': 'a19eccbc69892304',
  'dotm-circular-2@14': 'a86b20e73c1b150b',
  'dotm-circular-3@default': 'e9d7e77e280a703f',
  'dotm-circular-3@14': 'bb6df137c5cc9bf7',
  'dotm-circular-4@default': 'ad9f6a3596f94faa',
  'dotm-circular-4@14': '5f8cd4a6493020df',
  'dotm-circular-5@default': '9c93a7919deef42c',
  'dotm-circular-5@14': '01d52be15e2a4042',
  'dotm-circular-6@default': '6eb52694b80f9486',
  'dotm-circular-6@14': 'e79170bc45b7bd62',
  'dotm-circular-7@default': 'f5b7837a28917a18',
  'dotm-circular-7@14': '2b0aae5b1270bd5a',
  'dotm-circular-8@default': '6d143028d7613f00',
  'dotm-circular-8@14': '734cd27ae7ea2b80',
  'dotm-circular-9@default': '6b4a5b7dab1a31af',
  'dotm-circular-9@14': '8d18593a997afda0',
  'dotm-circular-10@default': '445e0dbda4381733',
  'dotm-circular-10@14': '1367be84204255ff',
  'dotm-circular-11@default': 'e1fb7b50d03c2280',
  'dotm-circular-11@14': '51236671e03ef72b',
  'dotm-circular-12@default': '3a91ad0d6ed55103',
  'dotm-circular-12@14': '0b0f2dc900a1a61f',
  'dotm-circular-14@default': 'e87b8da313199257',
  'dotm-circular-14@14': '853a2fb9bd68b694',
  'dotm-circular-15@default': 'a665faf3d83e26c4',
  'dotm-circular-15@14': '7347f6152d387bda',
  'dotm-circular-17@default': '4be005048e3e0875',
  'dotm-circular-17@14': '81055089fd07a69b',
  'dotm-square-1@default': 'f736a3855e3b8fed',
  'dotm-square-1@14': 'ef019f168e38fda5',
  'dotm-square-2@default': '67cc8a95007786f9',
  'dotm-square-2@14': '27b8b477d9e54cdc',
  'dotm-square-3@default': '2ccf33735bc01c15',
  'dotm-square-3@14': '0a811e75be7fd880',
  'dotm-square-4@default': 'eb798fd3eebf7293',
  'dotm-square-4@14': 'bddfc46337e795a8',
  'dotm-square-5@default': 'b8c24d4f0ee499cd',
  'dotm-square-5@14': 'd9b19536fa3a3df5',
  'dotm-square-6@default': '09fe8bf890017fb2',
  'dotm-square-6@14': '6ef63f22bb4d0715',
  'dotm-square-7@default': '6b78713e9ebeaaff',
  'dotm-square-7@14': 'abc38c2e2a996482',
  'dotm-square-8@default': 'eba5241aacb39132',
  'dotm-square-8@14': '9668ea72c76f3f66',
  'dotm-square-9@default': '3ce9b3b43a8b8b7e',
  'dotm-square-9@14': '89c1d56312687038',
  'dotm-square-10@default': '7b1aee7f85f7ed68',
  'dotm-square-10@14': '7812a42b6215dfe3',
  'dotm-square-11@default': '826e9bf4105dddb8',
  'dotm-square-11@14': '6dfe97b7dc9b73a4',
  'dotm-square-12@default': 'd0fc247b653fdbd3',
  'dotm-square-12@14': '512a04713e65ca3b',
  'dotm-square-13@default': '55270882df311202',
  'dotm-square-13@14': '1639db89c2e5764a',
  'dotm-square-14@default': '5edacc39e6e7832e',
  'dotm-square-14@14': '5edacc39e6e7832e',
  'dotm-square-15@default': '6e54b30d9b1082f4',
  'dotm-square-15@14': '44a8b661cbfe6624',
  'dotm-square-16@default': 'cf27104d3ffae191',
  'dotm-square-16@14': 'aad3c046f592f189',
  'dotm-square-17@default': '87df1ae116ebea78',
  'dotm-square-17@14': 'aae731bb935d4c7b',
  'dotm-square-18@default': '722bc4eab1bd813e',
  'dotm-square-18@14': '941ddac6bd1eb919',
  'dotm-square-19@default': '30dfe413a1c6fe83',
  'dotm-square-19@14': '630d39e341a22e1c',
  'dotm-square-20@default': 'ac5a55071750cb71',
  'dotm-square-20@14': '26254b388b3a05ff',
  'resolver:circular-1:animPhase': 'e6236d150e3a9d7b',
  'resolver:square-14:step': '5dbca031f0ef034a',
};

describe('dotm catalog markup characterization', () => {
  const SIZES = ['default', 14] as const;

  for (const entry of DOT_MATRIX_CATALOG) {
    for (const size of SIZES) {
      const key = `${entry.name}@${size === 'default' ? 'default' : '14'}`;
      test(`markup pin ${key}`, () => {
        const html =
          size === 'default'
            ? renderToStaticMarkup(<entry.Component />)
            : renderToStaticMarkup(<entry.Component size={14} />);
        const actual = digest({ root: rootToken(html), dots: dotTokens(html) });
        expect(actual).toBe(EXPECTED[key]);
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
    expect(digest(perSample)).toBe(EXPECTED['resolver:circular-1:animPhase']);
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
    expect(digest(perStep)).toBe(EXPECTED['resolver:square-14:step']);
  });
});
