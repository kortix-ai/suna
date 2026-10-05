import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Resolver-output pins for one continuous-cycle and one stepped-cycle dotm
 * variant (KRTX-653 phase 1). The animation resolvers live inside the
 * components and read the cycle hooks, so the tests drive sampled cycle
 * values through `mock.module('@/lib/dotmatrix-hooks')` and pin the exact
 * inline opacities the resolver returns for each sample.
 *
 * Opacity extraction: every active dot's resolver style carries `opacity:<n>`
 * inline; inactive dots have none (class-driven). Document order is
 * row-major, so the sequences below are position-pinned.
 */

let cyclePhase = 0;
let steppedStep = 0;

mock.module('@/lib/dotmatrix-hooks', () => ({
  usePrefersReducedMotion: () => false,
  useCyclePhase: () => cyclePhase,
  useSteppedCycle: () => steppedStep,
  useDotMatrixPhases: () => ({
    phase: 'loadingRipple',
    onMouseEnter: () => {},
    onMouseLeave: () => {},
  }),
}));

const { DotmCircular1 } = await import('./dotm-circular-1');
const { DotmSquare14 } = await import('./dotm-square-14');

const opacitiesOf = (html: string): string[] =>
  [...html.matchAll(/opacity:([\d.]+)/g)].map((match) => match[1]!);

describe('dotm-circular-1 resolver opacities over sampled cycle phases', () => {
  beforeEach(() => {
    cyclePhase = 0;
    steppedStep = 0;
  });

  // Ordered inline opacity per sampled cyclePhase — generated at
  // origin/main 41b2a206b. 21 values (the 4 mask corners are active but
  // class `dmx-inactive`, so they carry no inline opacity).
  const PINNED_PHASES: ReadonlyArray<[number, string]> = [
    [0, '1,1,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,0.24,0.08,0.08,0.24,1,1'],
    [
      0.05,
      '0.24,1,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,0.24,0.08,0.08,0.08,0.24,0.24,0.08,0.24,0.24,1,0.24',
    ],
    [
      0.25,
      '1,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,0.24,0.08,0.08,0.24,0.24,1,1,0.24,0.24,0.08,0.08,0.08',
    ],
    [
      0.5,
      '0.08,0.08,0.08,0.24,0.08,0.08,0.24,0.24,1,1,0.24,0.24,1,0.08,0.08,0.08,0.08,1,0.08,0.08,0.08',
    ],
    [
      0.75,
      '0.08,0.24,0.24,1,0.24,0.24,1,0.08,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,0.24,0.08,0.08,0.24,0.24',
    ],
    [
      0.999,
      '0.24,1,0.08,0.08,0.08,1,0.08,0.08,0.08,0.08,0.24,0.08,0.08,0.08,0.24,0.24,0.08,0.24,0.24,1,0.24',
    ],
  ];

  test.each(PINNED_PHASES)('cyclePhase %p renders the pinned opacity sequence', (phase, pinned) => {
    cyclePhase = phase;
    const html = renderToStaticMarkup(<DotmCircular1 />);
    expect(opacitiesOf(html).join(',')).toBe(pinned);
  });

  test('the strand moves with the phase and the corner mask holds', () => {
    const renders = PINNED_PHASES.map(([phase]) => {
      cyclePhase = phase;
      return renderToStaticMarkup(<DotmCircular1 />);
    });
    // The helix must actually travel: not every sampled phase renders the
    // same dot pattern.
    expect(new Set(renders.map((html) => opacitiesOf(html).join(','))).size).toBeGreaterThan(1);
    // The 4 mask corners stay class-inactive at every sampled phase.
    for (const html of renders) {
      expect([...html.matchAll(/class="dmx-dot dmx-inactive"/g)]).toHaveLength(4);
    }
  });
});

describe('dotm-square-14 resolver opacities over sampled cycle steps', () => {
  beforeEach(() => {
    cyclePhase = 0;
    steppedStep = 0;
  });

  // Ordered inline opacity per sampled useSteppedCycle step — generated at
  // origin/main 41b2a206b. 25 values (pattern 'full': every dot active).
  const PINNED_STEPS: ReadonlyArray<[number, string]> = [
    [
      0,
      '1,0.08,0.08,0.08,1,0.08,1,0.08,1,0.08,0.08,0.08,0.52,0.08,0.08,0.08,1,0.08,1,0.08,1,0.08,0.08,0.08,1',
    ],
    [
      1,
      '0.08,0.08,1,0.08,0.08,0.08,0.52,1,0.52,0.08,1,0.52,0.52,0.52,1,0.08,0.52,1,0.52,0.08,0.08,0.08,1,0.08,0.08',
    ],
    [
      2,
      '0.08,1,0.08,1,0.08,1,0.08,0.52,0.08,1,0.08,0.08,0.52,0.08,0.08,1,0.08,0.52,0.08,1,0.08,1,0.08,1,0.08',
    ],
    [
      3,
      '1,0.08,1,0.08,1,0.08,0.52,0.08,0.52,0.08,1,0.08,0.52,0.08,1,0.08,0.52,0.08,0.52,0.08,1,0.08,1,0.08,1',
    ],
    [
      4,
      '0.08,1,0.08,1,0.08,1,0.08,0.52,0.08,1,0.08,0.08,0.52,0.08,0.08,1,0.08,0.52,0.08,1,0.08,1,0.08,1,0.08',
    ],
    [
      5,
      '0.08,0.08,1,0.08,0.08,0.08,0.52,1,0.52,0.08,1,0.52,0.52,0.52,1,0.08,0.52,1,0.52,0.08,0.08,0.08,1,0.08,0.08',
    ],
  ];

  test.each(PINNED_STEPS)('step %p renders the pinned opacity sequence', (step, pinned) => {
    steppedStep = step;
    const html = renderToStaticMarkup(<DotmSquare14 />);
    expect(opacitiesOf(html).join(',')).toBe(pinned);
  });

  test('the frame sequence repeats 2 and 1 and never stands still', () => {
    // FRAME_SEQUENCE is [0,1,2,3,2,1]: the walk reverses, so steps 2 and 4
    // render the same frame and steps 1 and 5 render the same frame.
    const render = (step: number) => {
      steppedStep = step;
      return opacitiesOf(renderToStaticMarkup(<DotmSquare14 />)).join(',');
    };
    expect(render(4)).toBe(render(2));
    expect(render(5)).toBe(render(1));
    expect(render(3)).not.toBe(render(0));
  });
});
