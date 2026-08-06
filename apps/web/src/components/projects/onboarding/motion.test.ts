/**
 * The motion contract.
 *
 * Direction is the property worth protecting: the previous version drifted
 * every step upward whether the user pressed Continue or Back, so the animation
 * actively lied about which way they moved. These assertions make that
 * regression impossible to reintroduce silently.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ENTER_TRANSITION,
  EXIT_TRANSITION,
  REDUCED_TRANSITION,
  SEAL_TRANSITION,
  slideVariants,
} from './motion';

const shell = readFileSync(join(import.meta.dir, '..', 'project-onboarding-wizard.tsx'), 'utf8');

type Axis = { opacity: number; x: number };
const at = (v: unknown, direction: number) =>
  typeof v === 'function' ? (v as (d: number) => Axis)(direction) : (v as Axis);

describe('slideVariants', () => {
  test('uses the selected 16px travel distance', () => {
    const variants = slideVariants(false);
    expect(at(variants.enter, 1).x).toBe(16);
    expect(at(variants.exit, 1).x).toBe(-16);
  });
  test('forward pushes content left, backward pushes it right', () => {
    const variants = slideVariants(false);

    // Forward: the incoming step waits on the right and the outgoing exits left.
    expect(at(variants.enter, 1).x).toBeGreaterThan(0);
    expect(at(variants.exit, 1).x).toBeLessThan(0);

    // Backward is the exact mirror — otherwise Back feels like Continue.
    expect(at(variants.enter, -1).x).toBeLessThan(0);
    expect(at(variants.exit, -1).x).toBeGreaterThan(0);
  });

  test('settles at rest in the centre, fully opaque', () => {
    const center = slideVariants(false).center as Axis;
    expect(center.x).toBe(0);
    expect(center.opacity).toBe(1);
  });

  // Reduced motion removes MOVEMENT, not the animation. The crossfade still
  // explains that content was replaced; deleting it would cost comprehension.
  test('reduced motion drops travel but keeps the crossfade', () => {
    const variants = slideVariants(true);
    for (const direction of [1, -1]) {
      expect(at(variants.enter, direction).x).toBe(0);
      expect(at(variants.exit, direction).x).toBe(0);
      expect(at(variants.enter, direction).opacity).toBe(0);
    }
    expect((variants.center as Axis).opacity).toBe(1);
  });
});

describe('timing', () => {
  test('uses the selected step and reduced-motion timings', () => {
    expect(ENTER_TRANSITION.duration).toBe(0.22);
    expect(EXIT_TRANSITION.duration).toBe(0.17);
    expect(REDUCED_TRANSITION.duration).toBe(0.16);
  });
  // Exits run ~75-80% of enters: the user has already decided, so get out of
  // the way faster than you arrived.
  test('exits are faster than enters', () => {
    const enter = ENTER_TRANSITION.duration as number;
    const exit = EXIT_TRANSITION.duration as number;
    expect(exit).toBeLessThan(enter);
    expect(exit / enter).toBeGreaterThanOrEqual(0.7);
    expect(exit / enter).toBeLessThanOrEqual(0.8);
  });

  test('stays under the 300ms ceiling for UI motion', () => {
    expect(ENTER_TRANSITION.duration as number).toBeLessThanOrEqual(0.3);
    expect(EXIT_TRANSITION.duration as number).toBeLessThanOrEqual(0.3);
  });

  // Bounce belongs to drag and play, not chrome. The single exception is the
  // finish-step seal, which fires once per project.
  test('only the celebration seal is allowed any bounce', () => {
    expect(SEAL_TRANSITION.bounce).toBeGreaterThan(0);
    expect(ENTER_TRANSITION.bounce).toBeUndefined();
    expect(EXIT_TRANSITION.bounce).toBeUndefined();
  });
});

describe('wizard wiring', () => {
  // `wait` runs the exit to completion before the enter begins, which doubled
  // every step to ~440ms of dead air.
  test('steps overlap rather than queue', () => {
    expect(shell).toContain('mode="popLayout"');
    expect(shell).not.toContain('mode="wait"');
  });

  test('feeds direction to the variants', () => {
    expect(shell).toContain('custom={direction}');
    expect(shell).toContain('variants={stepVariants}');
  });

  // Without this the whole flow animates in on mount, behind the page load.
  test('does not animate on first mount', () => {
    expect(shell).toContain('initial={false}');
  });

  test('honours the reduced-motion preference', () => {
    expect(shell).toContain('useReducedMotion');
  });
});
