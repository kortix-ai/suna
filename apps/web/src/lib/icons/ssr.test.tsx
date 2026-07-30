import { describe, expect, test } from 'bun:test';
import { WrenchIcon as RawWrenchIcon } from '@phosphor-icons/react/dist/ssr';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_ICON_WEIGHT } from './icon-config';
import { CaretRightIcon, WrenchIcon } from './ssr';

describe('server-component icons', () => {
  test('carry the app-wide weight without a weight prop', () => {
    expect(renderToStaticMarkup(<WrenchIcon />)).toBe(
      renderToStaticMarkup(<RawWrenchIcon weight={DEFAULT_ICON_WEIGHT} />),
    );
  });

  test('do not fall back to phosphor’s own "regular" default', () => {
    expect(renderToStaticMarkup(<CaretRightIcon />)).not.toBe(
      renderToStaticMarkup(<RawWrenchIcon weight="regular" />),
    );
    expect(renderToStaticMarkup(<WrenchIcon />)).not.toBe(
      renderToStaticMarkup(<RawWrenchIcon />),
    );
  });

  test('let an explicit weight win', () => {
    expect(renderToStaticMarkup(<WrenchIcon weight="fill" />)).toBe(
      renderToStaticMarkup(<RawWrenchIcon weight="fill" />),
    );
  });

  test('pass through className and size', () => {
    const markup = renderToStaticMarkup(<WrenchIcon className="size-6" size={32} />);

    expect(markup).toContain('class="size-6"');
    expect(markup).toContain('width="32"');
  });
});
