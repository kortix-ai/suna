import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloseButton, dismiss } from './close-button';

/** Records which router call the branch made, in order. */
function fakeRouter() {
  const calls: string[] = [];
  return {
    calls,
    back: () => calls.push('back'),
    push: (href: string) => calls.push(`push:${href}`),
  };
}

describe('dismiss', () => {
  test('goes back when the tab has somewhere to go back to', () => {
    const router = fakeRouter();
    dismiss(router, 2);
    expect(router.calls).toEqual(['back']);
  });

  test('goes home from a fresh tab, where back() is a dead click', () => {
    // A pasted /download link, a target="_blank" jump, a link out of an email:
    // history.length is 1 and this X is the page's only exit, so back() would
    // leave the visitor stranded on the page they just tried to leave.
    const router = fakeRouter();
    dismiss(router, 1);
    expect(router.calls).toEqual(['push:/']);
  });

  test('never fires both, and never fires neither', () => {
    for (const length of [0, 1, 2, 3, 50]) {
      const router = fakeRouter();
      dismiss(router, length);
      expect(router.calls).toHaveLength(1);
    }
  });
});

describe('CloseButton', () => {
  const html = renderToStaticMarkup(<CloseButton onClose={() => {}} />);

  test('is reachable without sight of the glyph', () => {
    // The button's only child is an X path. Without the label a screen reader
    // announces an empty button.
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<svg');
  });

  test('sits in the viewport corner, not in the centred content column', () => {
    // `absolute` would pin it to main's max-w-5xl box, which is centred — about
    // 470px inside the right edge on a 1920px monitor, beside the cards instead
    // of at the corner.
    expect(html).toContain('fixed');
    expect(html).toContain('top-4');
    expect(html).toContain('right-4');
    expect(html).not.toContain('left-4');
  });

  test('is a round pill with a 40x40 hit area', () => {
    // size="icon-lg" is size-10. The glyph is 16px; the target must not be.
    expect(html).toContain('rounded-full');
    expect(html).toContain('size-10');
  });

  test('does not submit the form it may one day sit inside', () => {
    expect(html).toContain('type="button"');
  });
});
