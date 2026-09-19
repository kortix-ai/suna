import { describe, expect, test } from 'bun:test';

import {
  QUEUE_FAILURE_SENTENCE_KEYS,
  QUEUE_NOT_SENT_KEY,
  isRetryableFailure,
  queueFailureCopyKey,
  queueFailureLine,
} from './queue-failure-copy';

/** The server's own list (`PROMPT_FAILURE_CODES`), plus the two codes a send
 *  can fail with before the server has a row. */
const codes = [
  'out_of_credits',
  'model_unavailable',
  'connector_required',
  'runtime_unreachable',
  'not_landed',
  'redelivery_exhausted',
  'rewound',
  'session_gone',
  'refused',
  'upload_failed',
  'network',
] as const;

/** A translator that hands back the key, so a test reads which key was used. */
const copy = (key: string) => key;

describe('queueFailureCopyKey', () => {
  for (const code of codes) {
    test(`${code} has a sentence of its own`, () => {
      const key = queueFailureCopyKey(code);
      expect(key).toBe(QUEUE_FAILURE_SENTENCE_KEYS[code]);
      // `i18nComplete.`-prefixed, exactly like `queue-action-copy.ts`: both
      // modules are read with a `hardcodedUi`-scoped translator.
      expect(key).toMatch(/^i18nComplete\.text[0-9a-f]{12}$/);
    });
  }

  test('every code maps to a DIFFERENT sentence', () => {
    const keys = codes.map((code) => queueFailureCopyKey(code));
    expect(new Set(keys).size).toBe(codes.length);
  });

  test('a cause the server could not name, or none at all, has no sentence', () => {
    expect(queueFailureCopyKey('unknown')).toBeNull();
    expect(queueFailureCopyKey(null)).toBeNull();
    expect(queueFailureCopyKey(undefined)).toBeNull();
    // A code this build has never heard of — a newer server. The raw reason is
    // still shown, which is what the fallback line is for.
    expect(queueFailureCopyKey('quota_exhausted')).toBeNull();
  });
});

describe('queueFailureLine', () => {
  test('a named cause reads as one sentence, and the raw reason only hovers', () => {
    expect(
      queueFailureLine({
        failureCode: 'out_of_credits',
        lastError: 'Out of credits. Top up to continue.',
        copy,
      }),
    ).toEqual({
      text: QUEUE_FAILURE_SENTENCE_KEYS.out_of_credits,
      title: 'Out of credits. Top up to continue.',
    });
  });

  test('an unnamed cause keeps the reason in the line, and never repeats it on hover', () => {
    // The reason IS the line here, so a `title` would be a tooltip that says
    // the sentence under the pointer back to the user.
    expect(queueFailureLine({ failureCode: 'unknown', lastError: 'boom', copy })).toEqual({
      text: `${QUEUE_NOT_SENT_KEY} — boom`,
    });
  });

  test('no code and no reason says only that it was not sent', () => {
    expect(queueFailureLine({ copy })).toEqual({ text: QUEUE_NOT_SENT_KEY });
  });

  test('a sentence is shown even when the server sent no reason to hover', () => {
    expect(queueFailureLine({ failureCode: 'session_gone', copy })).toEqual({
      text: QUEUE_FAILURE_SENTENCE_KEYS.session_gone,
    });
  });
});

describe('isRetryableFailure', () => {
  test('a session that no longer exists can never take the prompt', () => {
    expect(isRetryableFailure('session_gone')).toBe(false);
  });

  test('every other cause can be sent again', () => {
    for (const code of codes) {
      if (code === 'session_gone') continue;
      expect(isRetryableFailure(code)).toBe(true);
    }
    expect(isRetryableFailure('unknown')).toBe(true);
    expect(isRetryableFailure(null)).toBe(true);
  });
});

/** Every catalogue the app ships. A key present only in `en.json` renders as
 *  the raw `textXXXXXXXXXXXX` to everyone else, and nothing else would catch
 *  it: `raw` on a missing key returns the key instead of throwing. */
const LOCALES = ['en', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'] as const;

describe('the catalogues', () => {
  for (const locale of LOCALES) {
    test(`${locale} carries every key this module names`, async () => {
      const messages = (await import(`@/../translations/${locale}.json`)).default as {
        hardcodedUi: { i18nComplete: Record<string, string> };
      };
      for (const key of [QUEUE_NOT_SENT_KEY, ...Object.values(QUEUE_FAILURE_SENTENCE_KEYS)]) {
        // The keys are `hardcodedUi`-scoped, so the namespace is walked.
        const sentence = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], {
            i18nComplete: messages.hardcodedUi.i18nComplete,
          });
        expect(sentence, `${locale} is missing ${key}`).toBeString();
        expect((sentence as string).length, `${locale} has an empty ${key}`).toBeGreaterThan(0);
      }
    });
  }
});
