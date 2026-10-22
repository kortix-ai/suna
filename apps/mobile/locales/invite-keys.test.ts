import { describe, expect, test } from 'bun:test';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The invite screen and the switcher's Invites group (KRTX-1731): every
// locale has its own string for every `invites.*` key, with the same
// placeholders as English.

const en: Record<string, string> = require('./en.json').invites;
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

describe('invites strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    test(`${locale} has every key with the English placeholders`, () => {
      const strings: Record<string, string> = require(`./${locale}.json`).invites;
      expect(Object.keys(strings).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        expect(strings[key]).toBeTruthy();
        expect(placeholders(strings[key])).toEqual(placeholders(text));
      }
    });
  }
});
