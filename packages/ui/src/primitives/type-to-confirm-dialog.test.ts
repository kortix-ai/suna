import { describe, expect, test } from 'bun:test';

import { confirmationPhraseMatches } from './type-to-confirm-dialog';

/**
 * `TypeToConfirmDialog` renders through a Radix portal, which emits NOTHING
 * under `renderToStaticMarkup` (`general-tab.test.tsx` documents the same
 * constraint for `ConfirmDialog`), and `apps/web` has no DOM test harness. A
 * test that tried to assert on the rendered confirm button's `disabled`
 * attribute would therefore be structurally unable to fail.
 *
 * So the gate is a pure function and the gate is what gets tested. Every case
 * below is a real call with a real return value — no source scanning, no
 * rendered-output substring matching.
 */
describe('confirmationPhraseMatches', () => {
  test('the exact phrase arms the action', () => {
    expect(confirmationPhraseMatches('Acme Prod', 'Acme Prod')).toBe(true);
  });

  test('a different name does NOT arm the action', () => {
    // The failure this whole component exists to prevent: right button, wrong
    // workspace.
    expect(confirmationPhraseMatches('Acme Staging', 'Acme Prod')).toBe(false);
  });

  test('a prefix of the phrase does NOT arm the action', () => {
    expect(confirmationPhraseMatches('Acme', 'Acme Prod')).toBe(false);
  });

  test('the phrase plus extra characters does NOT arm the action', () => {
    expect(confirmationPhraseMatches('Acme Prod 2', 'Acme Prod')).toBe(false);
  });

  test('untouched input never arms', () => {
    expect(confirmationPhraseMatches('', 'Acme Prod')).toBe(false);
  });

  /**
   * The dangerous case, and the reason rule 1 exists in the implementation.
   * `confirmPhrase` is fed from `project?.name`, which is `undefined` (and
   * defaulted to `''`) while the project query is still loading or has
   * errored. A naive `typed === phrase` compares `'' === ''` and arms the
   * destroy button on a dialog the user has not typed a single character into.
   */
  describe('a blank phrase can never arm the action, whatever is typed', () => {
    for (const phrase of ['', '   ', '\t', '\n']) {
      for (const typed of ['', '   ', 'anything', 'Acme Prod']) {
        test(`phrase ${JSON.stringify(phrase)} + typed ${JSON.stringify(typed)}`, () => {
          expect(confirmationPhraseMatches(typed, phrase)).toBe(false);
        });
      }
    }
  });

  test('whitespace-only input does not arm a real phrase', () => {
    expect(confirmationPhraseMatches('   ', 'Acme Prod')).toBe(false);
  });

  describe('paste artifacts are tolerated — leading/trailing whitespace is never intent', () => {
    test('a trailing space still arms', () => {
      expect(confirmationPhraseMatches('Acme Prod ', 'Acme Prod')).toBe(true);
    });

    test('a leading space still arms', () => {
      expect(confirmationPhraseMatches('  Acme Prod', 'Acme Prod')).toBe(true);
    });

    test('a phrase stored with stray whitespace still matches clean input', () => {
      expect(confirmationPhraseMatches('Acme Prod', '  Acme Prod  ')).toBe(true);
    });
  });

  describe('case is not part of the guarantee', () => {
    // What is being bought is "the user knows which workspace this is".
    // Lowercasing proves that just as well as matching capitals, so requiring
    // exact case would add friction and buy no safety.
    test('all-lowercase input arms a mixed-case phrase', () => {
      expect(confirmationPhraseMatches('acme prod', 'Acme Prod')).toBe(true);
    });

    test('all-uppercase input arms a mixed-case phrase', () => {
      expect(confirmationPhraseMatches('ACME PROD', 'Acme Prod')).toBe(true);
    });
  });

  describe('internal whitespace IS part of the name and is not normalised away', () => {
    test('a collapsed inner space does not arm', () => {
      // "AcmeProd" is a different workspace name than "Acme Prod". Only the
      // OUTER whitespace is a paste artifact.
      expect(confirmationPhraseMatches('AcmeProd', 'Acme Prod')).toBe(false);
    });

    test('a doubled inner space does not arm', () => {
      expect(confirmationPhraseMatches('Acme  Prod', 'Acme Prod')).toBe(false);
    });
  });

  describe('names that are not plain ASCII words still work', () => {
    test('emoji and punctuation match exactly', () => {
      expect(confirmationPhraseMatches('🚀 ship-it (v2)', '🚀 ship-it (v2)')).toBe(true);
    });

    test('a near-miss on punctuation does not arm', () => {
      expect(confirmationPhraseMatches('🚀 ship-it v2', '🚀 ship-it (v2)')).toBe(false);
    });

    test('non-latin names match exactly', () => {
      expect(confirmationPhraseMatches('東京', '東京')).toBe(true);
    });
  });
});
