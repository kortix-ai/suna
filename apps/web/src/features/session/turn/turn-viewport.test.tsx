import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

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
