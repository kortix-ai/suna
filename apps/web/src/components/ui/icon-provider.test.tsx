import { PlusIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';
import { DEFAULT_ICON_SIZE, IconProvider } from './icon-provider';

describe('IconProvider', () => {
  test('icons inherit the configured weight without a weight prop', () => {
    const inProvider = renderToStaticMarkup(
      <IconProvider>
        <PlusIcon />
      </IconProvider>,
    );

    expect(inProvider).toContain(
      renderToStaticMarkup(<PlusIcon weight={DEFAULT_ICON_WEIGHT} size={DEFAULT_ICON_SIZE} />),
    );
  });

  test('a per-icon weight prop overrides the configured weight', () => {
    const inProvider = renderToStaticMarkup(
      <IconProvider>
        <PlusIcon weight="fill" />
      </IconProvider>,
    );

    expect(inProvider).toContain(
      renderToStaticMarkup(<PlusIcon weight="fill" size={DEFAULT_ICON_SIZE} />),
    );
    expect(inProvider).not.toContain(
      renderToStaticMarkup(<PlusIcon weight={DEFAULT_ICON_WEIGHT} size={DEFAULT_ICON_SIZE} />),
    );
  });

});
