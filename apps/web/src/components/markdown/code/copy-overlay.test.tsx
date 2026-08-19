import { CopyButton } from '@/components/markdown/copy-button';
import { describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CopyOverlay } from './copy-overlay';

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element in a tree, depth-first. Collected into an array rather than
 *  searched in place so the walk needs no narrowing across the closure. */
function collectElements(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const element = child as AnyElement;
    out.push(element);
    collectElements((element.props as { children?: ReactNode }).children, out);
  });
  return out;
}

/** The frame a migrating call site brings with it. */
const CHILD = <pre className="my-own-frame">const a = 1;</pre>;
const CHILD_MARKUP = renderToStaticMarkup(CHILD);

describe('CopyOverlay', () => {
  test("renders its child's markup unchanged", () => {
    const markup = renderToStaticMarkup(<CopyOverlay code="const a = 1;">{CHILD}</CopyOverlay>);

    // Verbatim: the child is not cloned, re-keyed, or wrapped in a way that
    // would change what the call site drew.
    expect(CHILD_MARKUP).toBe('<pre class="my-own-frame">const a = 1;</pre>');
    expect(markup).toContain(CHILD_MARKUP);
  });

  test('emits a copy control carrying the given code', () => {
    const code = 'echo "hello"';

    expect(renderToStaticMarkup(<CopyOverlay code={code}>{CHILD}</CopyOverlay>)).toContain(
      'aria-label="Copy code"',
    );

    // The code itself lives in a closure inside CopyButton, never in the
    // markup, so the prop is what proves it arrived.
    const buttons = collectElements(CopyOverlay({ code, children: CHILD })).filter(
      (element) => element.type === CopyButton,
    );

    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.code).toBe(code);
  });

  test('pins the control to the top-right of the frame it covers', () => {
    // BetterCodeBlock's exact placement. The three sites moving onto CopyOverlay
    // keep their button where it is today only while these two survive.
    const markup = renderToStaticMarkup(<CopyOverlay code="x">{CHILD}</CopyOverlay>);

    expect(markup).toContain('class="group relative h-full w-full"');
    expect(markup).toContain('class="absolute top-3 right-3 z-30"');
  });

  test('className extends the wrapper rather than replacing it', () => {
    const markup = renderToStaticMarkup(
      <CopyOverlay code="x" className="max-h-64">
        {CHILD}
      </CopyOverlay>,
    );

    expect(markup).toContain('relative');
    expect(markup).toContain('max-h-64');
  });
});
