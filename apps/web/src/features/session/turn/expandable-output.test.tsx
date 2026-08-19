import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { COLLAPSED_MAX_HEIGHT, ExpandableRegion, nextContentHeight } from './expandable-output';

/**
 * `ExpandableRegion`, not `ExpandableOutput`, on purpose.
 *
 * `ExpandableOutput` derives `canExpand` from a `ResizeObserver`, and the only
 * render this app can run is `renderToStaticMarkup`, where effects never commit
 * — so through the container `canExpand` is permanently `false`, the fade and
 * the toggle never render, and every assertion below would pass no matter what
 * that markup said. Driving the prop seam directly is what gives these tests
 * the ability to fail.
 */
const renderRegion = (props: Partial<React.ComponentProps<typeof ExpandableRegion>> = {}) =>
  renderToStaticMarkup(
    <ExpandableRegion
      canExpand
      expanded={false}
      onToggle={() => {}}
      contentHeight={900}
      {...props}
    >
      <p>command output</p>
    </ExpandableRegion>,
  );

/**
 * `max-height:` with the colon, never the bare string — the clamp's className
 * carries `transition-[max-height]`, so a substring check for `max-height`
 * matches every render and the assertion could never fail.
 */
const INLINE_CLAMP = 'max-height:';

describe('ExpandableRegion — the clamp', () => {
  test('clamps before the measurement lands, so a long body never flashes open', () => {
    // contentHeight 0 is the PRE-MEASUREMENT state, not a short body. Defaulting
    // to clamped is what stops a long body rendering full-height for the frame
    // before its measurement arrives.
    const markup = renderRegion({ canExpand: false, contentHeight: 0 });
    expect(markup).toContain(`${INLINE_CLAMP}${COLLAPSED_MAX_HEIGHT}px`);
  });

  test('clamps a long body that the reader has not opened', () => {
    // The default state, and the only one nobody chose.
    const markup = renderRegion({ canExpand: true, expanded: false, contentHeight: 900 });
    expect(markup).toContain(`${INLINE_CLAMP}${COLLAPSED_MAX_HEIGHT}px`);
    expect(markup).toContain('>Expand<');
  });

  test('opens to the measured height plus room for the toggle', () => {
    const markup = renderRegion({ expanded: true, contentHeight: 900 });
    // 900 measured + 48 CONTROL_ROOM. `box-sizing: border-box` puts the `pb-12`
    // inside max-height, so the padding has to be added or the toggle is clipped.
    expect(markup).toContain('max-height:948px');
    expect(markup).toContain('pb-12');
  });

  test('drops the clamp for a measured body that is too short to expand', () => {
    // 289–292px sits above the clamp but below the OVERFLOW_SLACK threshold, so
    // it gets no toggle. Clamping it anyway would shave pixels off the last line
    // with no affordance to get them back.
    expect(renderRegion({ canExpand: false, contentHeight: 290 })).not.toContain(INLINE_CLAMP);
  });

  test('a short body is neither clamped nor openable', () => {
    const markup = renderRegion({ canExpand: false, expanded: true, contentHeight: 40 });
    expect(markup).not.toContain(INLINE_CLAMP);
    expect(markup).not.toContain('>Collapse<');
  });
});

describe('ExpandableRegion — the affordance', () => {
  test('short output gets no toggle and no fade', () => {
    const markup = renderRegion({ canExpand: false, contentHeight: 40 });
    expect(markup).not.toContain('>Expand<');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).not.toContain('bg-gradient-to-t');
  });

  test('long output gets a centred transparent toggle over a bottom fade', () => {
    const markup = renderRegion();
    expect(markup).toContain('>Expand<');
    expect(markup).toContain('aria-expanded="false"');
    // The spec: transparent variant, horizontally centred, bottom-4.
    expect(markup).toContain('bottom-4');
    expect(markup).toContain('left-1/2');
    expect(markup).toContain('-translate-x-1/2');
    expect(markup).toContain('bg-transparent');
    // Bottom gradient fade, keyed to the surface the panel sits on.
    expect(markup).toContain('bg-gradient-to-t');
    expect(markup).toContain('from-secondary');
    expect(markup).toContain('to-transparent');
  });

  test('the fade dissolves rather than unmounting, so it tracks the height change', () => {
    expect(renderRegion({ expanded: false })).toContain('opacity-100');
    const open = renderRegion({ expanded: true });
    expect(open).toContain('bg-gradient-to-t');
    expect(open).toContain('opacity-0');
  });

  test('the toggle flips its label and its state when open', () => {
    const markup = renderRegion({ expanded: true });
    expect(markup).toContain('>Collapse<');
    expect(markup).toContain('aria-expanded="true"');
  });

  test('an expanded flag is ignored while there is nothing to expand', () => {
    // Guards the shrink case: content that drops below the clamp while open
    // must not leave a stale `expanded` holding max-height above the content.
    const markup = renderRegion({ canExpand: false, expanded: true, contentHeight: 40 });
    expect(markup).not.toContain('>Collapse<');
  });

  test('the toggle names the region it controls', () => {
    const markup = renderRegion();
    const controls = /aria-controls="([^"]+)"/.exec(markup)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`id="${controls}"`);
  });

  test('labels are overridable', () => {
    const markup = renderRegion({ expandLabel: 'Show output' });
    expect(markup).toContain('>Show output<');
  });
});

describe('nextContentHeight — a skipped subtree must not read as empty', () => {
  test('rejects a zero height so an open block cannot shut itself off screen', () => {
    // The bug: every turn is `content-visibility: auto`, so scrolling an open
    // block out of view makes the browser report a 0-size box. Stored, that
    // dropped `canExpand`, snapped `maxHeight` back to the clamp, and pulled
    // every turn below it up under the reader.
    expect(nextContentHeight(900, 0)).toBe(900);
  });

  test('rejects negative and non-finite readings', () => {
    expect(nextContentHeight(900, -1)).toBe(900);
    expect(nextContentHeight(900, Number.NaN)).toBe(900);
    expect(nextContentHeight(900, Number.POSITIVE_INFINITY)).toBe(900);
  });

  test('is identity for an unchanged height, so React bails out of the render', () => {
    // Value identity is the whole point: a re-render would mount/unmount the
    // toggle, which the transcript MutationObserver reads as a content change.
    expect(nextContentHeight(900, 900)).toBe(900);
    expect(nextContentHeight(901, 900.2)).toBe(901);
  });

  test('accepts a real height, rounded up so max-height never clips the last line', () => {
    expect(nextContentHeight(0, 300.2)).toBe(301);
    expect(nextContentHeight(900, 412)).toBe(412);
  });

  test('accepts a genuine shrink, so re-measured content still tracks', () => {
    expect(nextContentHeight(900, 120)).toBe(120);
  });
});

describe('ExpandableRegion — motion', () => {
  test('animates only the properties it changes, and honours reduced motion', () => {
    const markup = renderRegion();
    expect(markup).toContain('transition-[max-height]');
    expect(markup).toContain('transition-opacity');
    // Principle: never `transition: all`. The Button base ships `transition-all`;
    // the className below has to win the twMerge `transition` group.
    expect(markup).toContain('transition-[color,scale]');
    expect(markup).not.toContain('transition-all');
    expect(markup).toContain('motion-reduce:transition-none');
  });
});
