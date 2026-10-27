/**
 * The one connector logo (`ConnectorLogo`), on the rendered output and the
 * REAL error path: react-test-renderer fires the `<img>`'s `onError` the way a
 * browser does when a logo URL fails, then the tile must swap to the neutral
 * fallback.
 *
 * react-test-renderer because apps/web has no DOM harness (no jsdom — see
 * `settings-row.test.tsx`); an `<img>` error event needs no layout, only the
 * handler the browser would call.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { ConnectorLogo } from '../../../../../../../../packages/ui/src/internal/connector-logo/connector-logo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOGO = 'https://integrations.sh/logo/slack.com';

describe('ConnectorLogo', () => {
  test('an app with an icon renders it at the card tile size', () => {
    const html = renderToStaticMarkup(<ConnectorLogo source={{ icon: LOGO }} size="lg" />);
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain('size-9');
    expect(html).toContain('object-contain');
  });

  test('an app without a logo renders the neutral tile, no image', () => {
    const html = renderToStaticMarkup(<ConnectorLogo source={{ slug: 'internal-api' }} size="lg" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('size-9');
  });

  test('a Kortix-built connector draws its own mark, the same for every name it goes by', () => {
    const marks = [
      { nativeApp: 'computer' },
      { slug: 'computer', provider: 'computer' },
      { slug: 'native:computer', icon: '/connector-icons/computer.svg' },
    ].map((source) => renderToStaticMarkup(<ConnectorLogo source={source} size="lg" />));
    expect(marks[0]).not.toContain('<img');
    expect(new Set(marks).size).toBe(1);
    expect(marks[0]).not.toBe(renderToStaticMarkup(<ConnectorLogo source={{}} size="lg" />));
  });

  test('a logo URL that fails to load swaps to the neutral tile', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ConnectorLogo source={{ icon: LOGO }} />);
    });
    const img = renderer.root.findByType('img');
    expect(img.props.onError).toBeTypeOf('function');
    act(() => {
      img.props.onError();
    });
    // The image is gone and the fallback took its place — the same tile a
    // connector with no logo gets, so "missing" and "broken" look identical.
    expect(() => renderer.root.findByType('img')).toThrow();
    expect(renderer.root.findByType('svg')).toBeDefined();
  });

  test('a new icon URL after a failed one gets its own try', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ConnectorLogo source={{ icon: LOGO }} />);
    });
    act(() => {
      renderer.root.findByType('img').props.onError();
    });
    expect(() => renderer.root.findByType('img')).toThrow();
    const NEXT = 'https://integrations.sh/logo/github.com';
    act(() => {
      renderer.update(<ConnectorLogo source={{ icon: NEXT }} />);
    });
    expect(renderer.root.findByType('img').props.src).toBe(NEXT);
  });
});
