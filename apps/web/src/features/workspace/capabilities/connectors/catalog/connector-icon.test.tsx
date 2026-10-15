/**
 * The catalogue card's icon tile (`ConnectorIcon`).
 *
 * Asserted on the rendered output and on the REAL error path: the test renders
 * the component with react-test-renderer and fires the `<img>`'s `onError` the
 * way a browser does when a logo URL fails, then checks the tile swapped to the
 * glyph fallback. Before the broken-image state existed this test failed — the
 * dead URL kept rendering the broken `<img>` and `onError` was not even a prop.
 *
 * react-test-renderer because apps/web has no DOM harness (no jsdom — see
 * `settings-row.test.tsx`); an `<img>` error event needs no layout, only the
 * handler the browser would call.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { ConnectorIcon } from './connector-browse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOGO = 'https://integrations.sh/logo/slack.com';

describe('ConnectorIcon', () => {
  test('a record with an icon renders the favicon at the card tile size', () => {
    const html = renderToStaticMarkup(<ConnectorIcon icon={LOGO} />);
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain('size-9');
    expect(html).toContain('object-contain');
  });

  test('a record without an icon renders the glyph tile, no image', () => {
    const html = renderToStaticMarkup(<ConnectorIcon icon={null} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('size-9');
  });

  test('the computer record without an icon shows its own glyph, not the globe', () => {
    const html = renderToStaticMarkup(<ConnectorIcon icon={null} computer />);
    expect(html).not.toContain('<img');
    // Phosphor renders the glyph as a bare path (no `ph-*` class here), so the
    // assertion is that the monitor's tile is a DIFFERENT svg from the globe's.
    expect(html).toContain('<svg');
    expect(html).not.toBe(renderToStaticMarkup(<ConnectorIcon icon={null} />));
  });

  test('a logo URL that fails to load swaps to the glyph tile', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ConnectorIcon icon={LOGO} />);
    });
    const img = renderer.root.findByType('img');
    expect(img.props.onError).toBeTypeOf('function');

    act(() => {
      img.props.onError();
    });

    // The image is gone and the glyph tile took its place — the same fallback
    // a record with no icon gets, so "missing" and "unavailable" look identical.
    expect(() => renderer.root.findByType('img')).toThrow();
    expect(renderer.root.findByType('svg')).toBeDefined();
  });

  test('a new icon URL after a failed one gets its own try', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ConnectorIcon icon={LOGO} />);
    });
    act(() => {
      renderer.root.findByType('img').props.onError();
    });
    expect(() => renderer.root.findByType('img')).toThrow();

    // merge-search swaps a merged twin's icon to the managed logo as the
    // catalogue pages stream in — a URL swap with no remount; the latch is
    // per URL, so the new URL renders fresh instead of inheriting the old
    // failure.
    const NEXT = 'https://integrations.sh/logo/github.com';
    act(() => {
      renderer.update(<ConnectorIcon icon={NEXT} />);
    });
    expect(renderer.root.findByType('img').props.src).toBe(NEXT);
  });
});
