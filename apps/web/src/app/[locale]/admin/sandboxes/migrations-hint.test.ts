// KRTX-2383: the sandboxes analytics "Provisions" tile hinted
// `${n} migrations` in English on every locale, and "1 migrations" for one.
// KRTX-2384: the debug tools page had a Collapse all / Expand all button that
// toggled a state nothing read.
import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import de from '../../../../../translations/de.json';
import en from '../../../../../translations/en.json';

const namespace = 'hardcodedUi.i18nComplete';
const tEn = createTranslator({ locale: 'en', messages: en, namespace });
const tDe = createTranslator({ locale: 'de', messages: de, namespace });

describe('admin page copy and controls', () => {
  test('the migrations hint comes from the catalog, with a real plural', () => {
    const page = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');
    expect(page).not.toContain('} migrations`');
    expect(page).toContain("tI18nComplete('textbdb4791584c6', { count: an.totals.migrations })");
    expect(tEn('textbdb4791584c6', { count: 1 })).toBe('1 migration');
    expect(tEn('textbdb4791584c6', { count: 3 })).toBe('3 migrations');
    expect(tDe('textbdb4791584c6', { count: 1 })).toBe('1 Migration');
    expect(tDe('textbdb4791584c6', { count: 3 })).toBe('3 Migrationen');
  });

  test('the debug tools page has no toggle that toggles nothing', () => {
    const page = readFileSync(
      resolve(import.meta.dir, '../../(system)/debug/tools/page.tsx'),
      'utf8',
    );
    expect(page).not.toContain('setOpen((v) => !v)');
    expect(page).not.toContain('const [open, setOpen]');
  });
});
