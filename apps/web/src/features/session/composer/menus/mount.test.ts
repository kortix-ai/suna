import { describe, expect, it } from 'bun:test';

import { mountDockedMenu, mountSuggestionMenu } from './mount';

/**
 * `mountSuggestionMenu` only ever touches `element.style` and calls
 * `props.mount`, so a plain object with a `style` bag is a complete stand-in
 * for an `HTMLElement` here — this repo's `bun test` has no DOM (see
 * `editor/composer-editor.test.ts`'s header for the same constraint).
 */
function fakeElement() {
  return { style: {} as Record<string, string> };
}

function fakeProps(rect: DOMRect | null) {
  const calls: { element: unknown; options?: { onPosition?: (p: PositionArg) => void } }[] = [];
  return {
    calls,
    props: {
      clientRect: rect ? () => rect : undefined,
      mount: (element: unknown, options?: { onPosition?: (p: PositionArg) => void }) => {
        calls.push({ element, options });
        return () => {};
      },
    },
  };
}

interface PositionArg {
  x: number;
  y: number;
  strategy: string;
}

const rectAt = (left: number, bottom: number) =>
  ({ left, bottom }) as DOMRect;

describe('mountSuggestionMenu', () => {
  it('passes onPosition, which is what stops the plugin hiding the menu', () => {
    // The regression this guards: without `onPosition`, @tiptap/suggestion's
    // `createMount` sets `visibility: hidden` at mount time and only clears it
    // from inside `computePosition().then(...)`. Any path where that promise
    // does not settle leaves a fully-rendered menu permanently invisible, with
    // no error. Supplying `onPosition` makes the plugin skip that branch
    // entirely, so this assertion is the fix.
    const { props, calls } = fakeProps(rectAt(10, 20));

    mountSuggestionMenu(props as never, fakeElement() as never);

    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.options?.onPosition).toBe('function');
  });

  it('sets an explicit z-index on the mounted element', () => {
    // The plugin appends to document.body and sets no z-index, so paint order
    // would otherwise depend on document order against every other body-level
    // portal in the app.
    const { props } = fakeProps(rectAt(10, 20));
    const element = fakeElement();

    mountSuggestionMenu(props as never, element as never);

    expect(element.style.zIndex).toBe('60');
    expect(element.style.position).toBe('absolute');
  });

  it('places the menu at the caret before any async positioning resolves', () => {
    const { props } = fakeProps(rectAt(120, 400));
    const element = fakeElement();

    mountSuggestionMenu(props as never, element as never);

    // Left edge of the caret; 4px below it — the plugin's own default
    // offset.mainAxis, so Floating UI's later result lands in the same place
    // and there is no visible jump.
    expect(element.style.left).toBe('120px');
    expect(element.style.top).toBe('404px');
  });

  it('still mounts when no caret rect is available', () => {
    const { props, calls } = fakeProps(null);
    const element = fakeElement();

    mountSuggestionMenu(props as never, element as never);

    expect(calls).toHaveLength(1);
    // No optimistic placement is possible, but the element must not be left
    // unpositioned or unstacked — Floating UI's first result will place it.
    expect(element.style.position).toBe('absolute');
    expect(element.style.zIndex).toBe('60');
  });

  it('applies Floating UI results, including a flip above the composer', () => {
    const { props, calls } = fakeProps(rectAt(120, 400));
    const element = fakeElement();

    mountSuggestionMenu(props as never, element as never);
    // A composer pinned to the bottom of the viewport has no room below the
    // caret, so Floating UI flips the menu upward and returns a y ABOVE it.
    calls[0]?.options?.onPosition?.({ x: 228, y: 94, strategy: 'absolute' });

    expect(element.style.left).toBe('228px');
    expect(element.style.top).toBe('94px');
    expect(element.style.position).toBe('absolute');
  });
});

describe('mountDockedMenu', () => {
  it('still passes onPosition — the docked menu would mount invisible without it', () => {
    // Same trap as the floating path, and easier to fall into here: a docked
    // menu has no use for Floating UI's coordinates, so omitting the callback
    // looks harmless. It is not — its ABSENCE is what makes the plugin set
    // `visibility: hidden` and only clear it from inside a promise callback.
    const { props, calls } = fakeProps(null);

    mountDockedMenu(props as never, fakeElement() as never);

    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.options?.onPosition).toBe('function');
  });

  it('lays the menu out in flow: static, full width, no coordinates, no z-index', () => {
    const { props } = fakeProps(rectAt(120, 400));
    const element = fakeElement();

    mountDockedMenu(props as never, element as never);

    expect(element.style.position).toBe('static');
    expect(element.style.width).toBe('100%');
    // The whole point of docking: no caret anchoring survives. A stray
    // `left`/`top`/`zIndex` here would lift the card back out of flow and
    // reintroduce exactly the overlap this replaced.
    expect(element.style.left).toBeUndefined();
    expect(element.style.top).toBeUndefined();
    expect(element.style.zIndex).toBeUndefined();
  });

  it('ignores every Floating UI result it is handed', () => {
    const { props, calls } = fakeProps(rectAt(120, 400));
    const element = fakeElement();

    mountDockedMenu(props as never, element as never);
    // autoUpdate keeps firing on scroll/resize for as long as the menu is
    // open. Each one must be a no-op, not a creeping re-position.
    calls[0]?.options?.onPosition?.({ x: 228, y: 94, strategy: 'absolute' });

    expect(element.style.position).toBe('static');
    expect(element.style.left).toBeUndefined();
    expect(element.style.top).toBeUndefined();
  });
});
