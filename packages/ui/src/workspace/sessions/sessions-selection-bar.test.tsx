/**
 * The selection bar's toggle button reads "Select all" until everything in the
 * current view is selected, then "Clear". Both labels must come from the
 * caller's locale — this pins the "Clear" branch through a real German
 * catalog, because an English translator cannot tell a hardcoded literal from
 * a catalog hit: both read the same.
 */
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import deMessages from '../../../../../apps/web/translations/de.json';
import { TooltipProvider } from '../../primitives/tooltip';

import { SessionsSelectionBar } from './sessions-selection-bar';

function renderBar(allSelected: boolean, locale?: 'de'): string {
  const tree = (
    <TooltipProvider>
      <SessionsSelectionBar
        selectedCount={3}
        selectableCount={7}
        allSelected={allSelected}
        onSelectAll={() => {}}
        onClearSelection={() => {}}
        onExit={() => {}}
        onDelete={() => {}}
        deleting={false}
      />
    </TooltipProvider>
  );
  if (!locale) return renderToStaticMarkup(tree);
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ hardcodedUi: deMessages.hardcodedUi }}
      timeZone="UTC"
      onError={() => {}}
    >
      {tree}
    </NextIntlClientProvider>,
  );
}

describe('SessionsSelectionBar — the select-all / clear toggle', () => {
  test('in English: Select all until everything is selected, then Clear', () => {
    expect(renderBar(false)).toContain('>Select all<');
    expect(renderBar(true)).toContain('>Clear<');
  });

  test('in German: both labels render through the catalog', () => {
    const german = renderBar(true, 'de');
    expect(german).toContain('>Leeren<');
    expect(german).not.toContain('>Clear<');
    expect(renderBar(false, 'de')).toContain('>Alle auswählen<');
  });
});
