import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderWithProviders } from '../timeline/__fixtures__/render';
import { ScenarioList } from '../timeline/__fixtures__/render-list';
import { scenarios } from '../timeline/__fixtures__/transcript';
import { turnGapClass } from '../timeline/session-timeline-list';
import { TurnViewport, turnContainmentClass } from './turn-viewport';

describe('turnContainmentClass — a turn may not skip before it has been measured', () => {
  test('an unmeasured turn carries no containment, so it lays out for real', () => {
    // This is the whole fix. `contain-intrinsic-size: auto` can only stand in at
    // a turn's LAST-REMEMBERED size, and a turn earns one by being laid out
    // while NOT skipping. Skip it first and it stands in at the flat 600px
    // guess — which is what threw the reader around when scrolling up.
    expect(turnContainmentClass(false)).toBe('');
  });

  test('a measured turn skips, with an intrinsic size it can now honour', () => {
    const className = turnContainmentClass(true);
    expect(className).toContain('[content-visibility:auto]');
    expect(className).toContain('[contain-intrinsic-size:auto_600px]');
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
  });

  test('keeps the scroll anchor every scroll consumer measures through', () => {
    // `useAutoScroll` (spacer + measureTarget) and `session-history-scroll`
    // both find turns by this attribute. Losing it silently breaks both.
    expect(render()).toContain('data-turn-id="turn-1"');
  });

  test('still applies caller spacing', () => {
    expect(render({ className: 'mt-12' })).toContain('mt-12');
  });

  test('renders its children', () => {
    expect(render()).toContain('turn body');
  });
});

describe('TurnFrame — the per-turn wrapper of the timeline list', () => {
  // `TurnFrame` keeps `TurnViewport` as its ROOT, so `[data-turn-id]` is the
  // outermost element of every turn and every `[data-turn-pending]` bubble is
  // its descendant — the nesting `use-auto-scroll.ts`, `session-history-scroll.ts`
  // and `chat-minimap.tsx` all measure through.
  test('renders TurnViewport as its root', () => {
    const markup = renderWithProviders(<ScenarioList scenario={scenarios[0]} />);
    expect(markup.startsWith('<div data-turn-id="')).toBe(true);
  });

  test('the turn gap is the wrapper class: none first, mt-3 stacked pending, mt-12 otherwise', () => {
    const pendingTurnIds = new Set(['b', 'c']);
    const gap = (index: number, id: string, prev: string | undefined, lastTurnWorking: boolean) =>
      turnGapClass({
        index,
        userMessageID: id,
        previousUserMessageID: prev,
        lastTurnWorking,
        pendingTurnIds,
      });
    expect(gap(0, 'a', undefined, true)).toBe('');
    expect(gap(1, 'b', 'a', true)).toBe('mt-12');
    expect(gap(2, 'c', 'b', true)).toBe('mt-3');
    // Stacking is a WORKING-session rule only.
    expect(gap(2, 'c', 'b', false)).toBe('mt-12');
  });
});
