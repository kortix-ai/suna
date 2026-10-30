import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  TURN_MIN_CONTAIN_PX,
  TurnViewport,
  turnIntrinsicSize,
  turnLayoutHeight,
  turnViewportClassName,
} from './turn-viewport';

describe('turnViewportClassName — the two containment rules', () => {
  test('RULE 1: an unmeasured turn carries no containment, so it lays out for real', () => {
    // A turn only earns a stand-in size by being laid out. Contain it before
    // that and it reports a size nobody measured — which is what threw the
    // reader around when scrolling up.
    expect(turnViewportClassName('unmeasured')).toBe('');
    expect(turnViewportClassName('unmeasured', 'mt-12', 320)).toBe('mt-12');
    expect(turnIntrinsicSize('unmeasured', 320)).toBeUndefined();
  });

  test('a measured turn skips, standing in at ITS OWN height — never a shared guess', () => {
    const className = turnViewportClassName('measured', 'mt-12', 320);
    expect(className).toContain('[content-visibility:auto]');
    expect(className).toContain('mt-12');
    // The regression this replaces: one flat `600px` for every turn. Real
    // turns are 100-500px, so every skipped turn inflated the transcript and
    // deflated again when it came back through the viewport.
    expect(className).not.toContain('contain-intrinsic-size');
    expect(turnIntrinsicSize('measured', 101)).toBe('auto 101px');
    expect(turnIntrinsicSize('measured', 503)).toBe('auto 503px');
  });

  test('the stand-in is the EXACT height: a rounded one moves everything under the turn when it is contained', () => {
    // Turn heights here are fractional (`--spacing` is 0.23rem). A whole-pixel
    // stand-in differs from the real height by up to 0.5px, and containment
    // swaps one for the other: 29 freshly loaded older turns, contained 500ms
    // after they rendered, moved the reader by ~4.5px in sum (measured).
    expect(turnIntrinsicSize('measured', 320.4)).toBe('auto 320.4px');
    expect(turnIntrinsicSize('measured', 279.59375)).toBe('auto 279.59375px');
  });

  test("a turn is measured at its layout height, not offsetHeight's whole pixels", () => {
    const turn = {
      offsetHeight: 280,
      getBoundingClientRect: () => ({ height: 279.59375 }),
    } as unknown as HTMLElement;
    expect(turnLayoutHeight(turn)).toBe(279.59375);
  });

  test('a measured turn with no height yet is not contained — no stand-in, no guess', () => {
    expect(turnIntrinsicSize('measured', 0)).toBeUndefined();
    expect(turnIntrinsicSize('measured', Number.NaN)).toBeUndefined();
  });

  test('RULE 3: a turn is never skipped at a stand-in too small to come back from', () => {
    // A skipped turn occupies its stand-in size, and `content-visibility: auto`
    // decides relevance from that box. Skip a turn at a few pixels and it can
    // never intersect the viewport, never lay out, never correct itself — the
    // reader gets invisible turns and a container with no extent. The old flat
    // 600px guess could not reach this state; a height-driven stand-in can, so
    // the floor is part of the contract.
    expect(turnIntrinsicSize('measured', 1)).toBeUndefined();
    expect(turnIntrinsicSize('measured', 4)).toBeUndefined();
    expect(turnIntrinsicSize('measured', TURN_MIN_CONTAIN_PX - 1)).toBeUndefined();
    expect(turnIntrinsicSize('measured', TURN_MIN_CONTAIN_PX)).toBe(
      `auto ${TURN_MIN_CONTAIN_PX}px`,
    );
    // Real turns measured on live threads: 101px one-line, 138px, 503px.
    expect(turnIntrinsicSize('measured', 101)).toBe('auto 101px');
  });

  test('RULE 3: the class and the style are the SAME fact — no containment without a stand-in', () => {
    // They cannot be allowed to disagree: `content-visibility: auto` with no
    // `contain-intrinsic-size` falls back to 0x0, which is the same dead end.
    for (const h of [0, 1, 4, TURN_MIN_CONTAIN_PX - 1]) {
      expect(turnViewportClassName('measured', 'mt-12', h)).not.toContain('content-visibility');
      expect(turnIntrinsicSize('measured', h)).toBeUndefined();
    }
    for (const h of [TURN_MIN_CONTAIN_PX, 101, 503]) {
      expect(turnViewportClassName('measured', 'mt-12', h)).toContain('[content-visibility:auto]');
      expect(turnIntrinsicSize('measured', h)).toBe(`auto ${h}px`);
    }
  });

  test('RULE 2: an empty turn gets NO containment — a 0px element never intersects, so it would skip forever at its stand-in size and oscillate', () => {
    const className = turnViewportClassName('empty', 'mt-12', 480);
    expect(className).not.toContain('content-visibility');
    expect(className).not.toContain('contain-intrinsic-size');
    // Even carrying a height from before it emptied out.
    expect(turnIntrinsicSize('empty', 480)).toBeUndefined();
  });

  test('RULE 2/3: a real but very short turn keeps its spacing — only an EMPTY one loses it', () => {
    // The floor governs CONTAINMENT, not layout: a 20px compaction row is a
    // real turn and must keep the margin its caller gave it.
    expect(turnViewportClassName('measured', 'mt-12', 20)).toBe('mt-12');
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

  test('carries data-turn-continues only for a row the auto-scroll must never anchor on', () => {
    // `useAutoScroll.sizeRoom` filters `[data-turn-id]:not([data-turn-continues])`:
    // a compaction and the work after it continue the turn above, and anchoring
    // on either is the running-compaction blank page (KRTX-2565). Losing the
    // attribute silently re-opens that bug.
    expect(render({ continues: true })).toContain('data-turn-continues="true"');
    expect(render({ continues: false })).not.toContain('data-turn-continues');
  });

  test('renders its children', () => {
    expect(render()).toContain('turn body');
  });
});
