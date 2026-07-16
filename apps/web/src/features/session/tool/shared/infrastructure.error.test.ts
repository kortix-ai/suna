import { describe, expect, test } from 'bun:test';

import {
  cleanErrorMessage,
  isErrorOutput,
  parseJsonFailure,
} from '@/features/session/tool/shared/infrastructure';

describe('cleanErrorMessage', () => {
  test('collapses repeated Error prefixes into one sentence', () => {
    expect(
      cleanErrorMessage(
        'Error: An unexpected error occurred while making the request. Error: Error: Was there a typo in the url or port?',
      ),
    ).toBe(
      'An unexpected error occurred while making the request. Was there a typo in the url or port?',
    );
  });

  test('strips a single leading Error prefix', () => {
    expect(cleanErrorMessage('Error: rate limit exceeded')).toBe('rate limit exceeded');
  });

  test('preserves typed errors that are not the Error prefix', () => {
    expect(cleanErrorMessage('TypeError: cannot read property foo')).toBe(
      'TypeError: cannot read property foo',
    );
  });

  test('falls back to the original when cleaning would empty it', () => {
    expect(cleanErrorMessage('Error:')).toBe('Error:');
  });

  test('collapses runs of whitespace', () => {
    expect(cleanErrorMessage('boom   \n  happened')).toBe('boom happened');
  });
});

describe('isErrorOutput', () => {
  test('detects the {success:false} failure contract', () => {
    expect(isErrorOutput('{"query":"x","success":false,"error":"Error: boom"}')).toBe(true);
  });

  test('detects a plain error string', () => {
    expect(isErrorOutput('Error: something failed')).toBe(true);
  });

  test('treats successful output as not an error', () => {
    expect(isErrorOutput('{"success":true,"results":[]}')).toBe(false);
    expect(isErrorOutput('Here are your results.')).toBe(false);
  });

  test('treats empty output as not an error', () => {
    expect(isErrorOutput('')).toBe(false);
  });
});

describe('parseJsonFailure', () => {
  test('extracts a cleanable summary from the failure contract', () => {
    const failure = parseJsonFailure('{"success":false,"error":"Error: boom"}');
    expect(failure).not.toBeNull();
    expect(cleanErrorMessage(failure!.errorSummary)).toBe('boom');
  });

  test('returns null for successful payloads', () => {
    expect(parseJsonFailure('{"success":true}')).toBeNull();
  });
});
