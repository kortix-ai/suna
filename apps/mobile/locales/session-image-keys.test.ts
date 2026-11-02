import { describe, expect, test } from 'bun:test';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The connecting screen's sandbox image card (`ImageStatus`,
// components/session/SessionConnecting.tsx): every locale has the title and
// one line for every image state `/start` can report.

const STATES = [
  'resolving',
  'serving_last_ready',
  'waiting_for_build',
  'building',
  'copying_to_region',
  'waiting_for_provider',
];

describe('sessionImage strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    test(`${locale} has the title and every state`, () => {
      const strings: { title: string; states: Record<string, string> } = require(`./${locale}.json`).sessionImage;
      expect(strings.title).toBeTruthy();
      expect(Object.keys(strings.states).sort()).toEqual([...STATES].sort());
      for (const state of STATES) expect(strings.states[state]).toBeTruthy();
    });
  }
});
