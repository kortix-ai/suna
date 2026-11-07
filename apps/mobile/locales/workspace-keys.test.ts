import { describe, expect, test } from 'bun:test';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// Workspaces (the Slack model): the create-or-join screen, the switcher, the
// Workspaces page and the workspace settings read `workspace.*`. Every locale
// has its own string for every key, with the same placeholders as English,
// and no locale's catalog still calls the container a project.

type Catalog = { [key: string]: string | Catalog };
const flatten = (node: Catalog, prefix = ''): Record<string, string> =>
  Object.entries(node).reduce<Record<string, string>>((out, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? { ...out, [path]: value } : { ...out, ...flatten(value, path) };
  }, {});

const en = flatten(require('./en.json').workspace);
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

describe('workspace strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    test(`${locale} has every key with the English placeholders`, () => {
      const strings = flatten(require(`./${locale}.json`).workspace);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        expect(strings[key]).toBeTruthy();
        expect(placeholders(strings[key])).toEqual(placeholders(text));
      }
    });
  }

  test('English never says "project" in a user-facing string, except the kept sample prompt', () => {
    const all = flatten(require('./en.json'));
    const hits = Object.entries(all)
      .filter(([, text]) => /\bprojects?\b/i.test(text))
      .map(([key]) => key);
    // A sample task the composer suggests ("Draft a project proposal"): a
    // project of the user's business, not the Kortix container.
    expect(hits).toEqual(['onboarding.docs.example']);
  });
});
