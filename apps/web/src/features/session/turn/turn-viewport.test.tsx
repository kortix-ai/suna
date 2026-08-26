import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TurnViewport, turnIntrinsicSize, turnViewportClassName } from './turn-viewport';

describe('turnViewportClassName — the two containment rules', () => {
  test('RULE 1: an unmeasured turn carries no containment, so it lays out for real', () => {
    // A turn only earns a stand-in size by being laid out. Contain it before
    // that and it reports a size nobody measured — which is what threw the
    // reader around when scrolling up.
    expect(turnViewportClassName('unmeasured')).toBe('');
    expect(turnViewportClassName('unmeasured', 'mt-12')).toBe('mt-12');
    expect(turnIntrinsicSize('unmeasured', 320)).toBeUndefined();
  });

  test('a measured turn skips, standing in at ITS OWN height — never a shared guess', () => {
    const className = turnViewportClassName('measured', 'mt-12');
    expect(className).toContain('[content-visibility:auto]');
    expect(className).toContain('mt-12');
    // The regression this replaces: one flat `600px` for every turn. Real
    // turns are 100-500px, so every skipped turn inflated the transcript and
    // deflated again when it came back through the viewport.
    expect(className).not.toContain('contain-intrinsic-size');
    expect(turnIntrinsicSize('measured', 101)).toBe('auto 101px');
    expect(turnIntrinsicSize('measured', 503)).toBe('auto 503px');
    expect(turnIntrinsicSize('measured', 320.4)).toBe('auto 320px');
  });

  test('a measured turn with no height yet is not contained — no stand-in, no guess', () => {
    expect(turnIntrinsicSize('measured', 0)).toBeUndefined();
    expect(turnIntrinsicSize('measured', Number.NaN)).toBeUndefined();
  });

  test('RULE 2: an empty turn gets NO containment — a 0px element never intersects, so it would skip forever at its stand-in size and oscillate', () => {
    const className = turnViewportClassName('empty', 'mt-12');
    expect(className).not.toContain('content-visibility');
    expect(className).not.toContain('contain-intrinsic-size');
    // Even carrying a height from before it emptied out.
    expect(turnIntrinsicSize('empty', 480)).toBeUndefined();
  });

  test("RULE 2: an empty turn drops its caller's spacing, so invisible turns contribute 0px", () => {
    // `mt-0` is merged AFTER the caller's classes — tailwind-merge keeps the
    // last of a conflicting pair, so the caller's mt-12/mt-3 is gone.
    expect(turnViewportClassName('empty', 'mt-12')).toBe('mt-0');
    expect(turnViewportClassName('empty', 'mt-3')).toBe('mt-0');
    expect(turnViewportClassName('empty')).toBe('mt-0');
  });
});

describe('TurnViewport', () => {
  // Effects never commit under `renderToStaticMarkup`, so this is the
  // pre-layout render — exactly the state the fix depends on being uncontained.
  const render = (props: Partial<React.ComponentProps<typeof TurnViewport>> = {}) =>
    renderToStaticMarkup(
      <TurnViewport turnId="turn-1" {...props}>
        <p>turn body</p>
      </TurnViewport>,
    );

  test('does not skip on the very first render', () => {
    const markup = render();
    expect(markup).not.toContain('content-visibility');
    expect(markup).not.toContain('contain-intrinsic-size');
    expect(markup).not.toContain('style=');
  });

  test('keeps the scroll anchor every scroll consumer measures through', () => {
    // `useAutoScroll` (spacer + measureTarget) and `session-history-scroll`
    // both find turns by this attribute. Losing it silently breaks both.
    expect(render()).toContain('data-turn-id="turn-1"');
  });

  test('still applies caller spacing before measurement', () => {
    expect(render({ className: 'mt-12' })).toContain('mt-12');
  });

  test('renders its children', () => {
    expect(render()).toContain('turn body');
  });
});
