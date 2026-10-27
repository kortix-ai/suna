import { describe, expect, test } from 'bun:test';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The connector approval waiting state (KRTX-1724): every locale has its own
// string for every `approvals.*` key, with the same placeholders as English.

const en: Record<string, string> = require('./en.json').approvals;
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

describe('approvals strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    test(`${locale} has every key with the English placeholders`, () => {
      const strings: Record<string, string> = require(`./${locale}.json`).approvals;
      expect(Object.keys(strings).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        expect(strings[key]).toBeTruthy();
        expect(placeholders(strings[key])).toEqual(placeholders(text));
      }
    });
  }
});
