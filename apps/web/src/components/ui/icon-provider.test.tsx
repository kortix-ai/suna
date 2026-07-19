import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlusIcon } from '@phosphor-icons/react';

import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';
import { IconProvider, useIconWeight } from './icon-provider';

function UseIconWeightConsumer() {
  useIconWeight();
  return null;
}

describe('IconProvider', () => {
  test('icons inherit the configured default weight and size 24', () => {
    const inProvider = renderToStaticMarkup(
      <IconProvider>
        <PlusIcon />
      </IconProvider>,
    );
    const explicit = renderToStaticMarkup(
      <PlusIcon weight={DEFAULT_ICON_WEIGHT} size={24} />,
    );
    expect(inProvider).toContain(explicit);
  });

  test('a per-icon weight prop overrides the global default', () => {
    const inProvider = renderToStaticMarkup(
      <IconProvider>
        <PlusIcon weight="duotone" />
      </IconProvider>,
    );
    const duotone = renderToStaticMarkup(<PlusIcon weight="duotone" size={24} />);
    expect(inProvider).toContain(duotone);
    expect(inProvider).not.toContain(
      renderToStaticMarkup(<PlusIcon weight={DEFAULT_ICON_WEIGHT} size={24} />),
    );
  });

  test('useIconWeight throws outside of IconProvider', () => {
    expect(() => renderToStaticMarkup(<UseIconWeightConsumer />)).toThrow(
      'useIconWeight must be used within IconProvider',
    );
  });
});
