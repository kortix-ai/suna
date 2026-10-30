import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import deMessages from '../../../../translations/de.json';
import { sidebarOpenerLabel } from '@kortix/ui/internal/layout/sidebar-opener';

// The labels must come from the caller's catalog, not from hardcoded English:
// assert the German copy so a hardcoded literal cannot pass as a translation.
const deUiTranslator = createTranslator({
  locale: 'de',
  messages: deMessages,
  namespace: 'hardcodedUi.i18nComplete',
});

describe('sidebarOpenerLabel catalog strings', () => {
  test("renders the labels in the caller's locale", () => {
    expect(sidebarOpenerLabel({ state: 'expanded' }, deUiTranslator)).toBe(
      'Seitenleiste einklappen',
    );
    expect(sidebarOpenerLabel({ state: 'collapsed', peek: true }, deUiTranslator)).toBe(
      'Seitenleiste anheften',
    );
    expect(sidebarOpenerLabel({ state: 'collapsed', peek: false }, deUiTranslator)).toBe(
      'Seitenleiste öffnen',
    );
    expect(sidebarOpenerLabel({ state: 'collapsed' }, deUiTranslator)).toBe('Seitenleiste öffnen');
  });
});
