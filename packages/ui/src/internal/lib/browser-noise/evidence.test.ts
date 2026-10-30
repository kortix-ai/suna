/**
 * Pins `stripErrorWrappers` against every wrapper class it must strip, with
 * and without the wrapper starting the message (KRTX-2409).
 *
 * The helper is the one place every noise rule routes through before
 * anchoring a pattern, so its contract is: strip every known wrapper prefix —
 * repeatedly, to fixpoint — from the start of the message, and touch nothing
 * else. The first four tests were RED before the helper was fixed: the old
 * regex (`^(?:Unhandled promise rejection: )?(?:[A-Za-z]+Error: )?`) required
 * at least one letter before `Error`, stripped at most one wrapper layer, and
 * did not know the `API error <N>: ` / `HTTP <N>: ` vocabulary — four rules
 * carried their own inline `.replace(/^Error: /, '')` patch to dodge it.
 */
import { describe, expect, test } from 'bun:test';

import { stripErrorWrappers } from './evidence';

describe('stripErrorWrappers', () => {
  // Golden cases from KRTX-2409. RED before the fix.
  test('strips a bare `Error: ` prefix', () => {
    expect(stripErrorWrappers('Error: boom')).toBe('boom');
  });

  test('strips an `API error <N>: ` prefix', () => {
    expect(stripErrorWrappers('API error 500: boom')).toBe('boom');
  });

  test('strips an `HTTP <N>: ` prefix', () => {
    expect(stripErrorWrappers('HTTP 429: boom')).toBe('boom');
  });

  test('strips stacked wrappers to fixpoint', () => {
    expect(stripErrorWrappers('Error: API error 500: boom')).toBe('boom');
    expect(stripErrorWrappers('Unhandled promise rejection: Error: boom')).toBe('boom');
    expect(stripErrorWrappers('Unhandled promise rejection: API error 503: HTTP 429: boom')).toBe(
      'boom',
    );
  });

  // Pre-fix behavior that must stay.
  test('strips a typed `<Name>Error: ` prefix', () => {
    expect(stripErrorWrappers('TypeError: boom')).toBe('boom');
    expect(stripErrorWrappers('SyntaxError: boom')).toBe('boom');
    expect(stripErrorWrappers('SecurityError: Failed to read the storage.')).toBe(
      'Failed to read the storage.',
    );
  });

  test('strips an `Unhandled promise rejection: ` prefix', () => {
    expect(stripErrorWrappers('Unhandled promise rejection: boom')).toBe('boom');
  });

  test('strips a rejection around a typed wrapper (pre-fix fixpoint)', () => {
    expect(stripErrorWrappers('Unhandled promise rejection: TypeError: boom')).toBe('boom');
    expect(stripErrorWrappers('Unhandled promise rejection: ApiError: Request timed out.')).toBe(
      'Request timed out.',
    );
  });

  test('leaves a non-wrapper prefix alone', () => {
    expect(stripErrorWrappers('Boom: boom')).toBe('Boom: boom');
  });

  test('leaves an interior wrapper alone (interior wrappers are not this helper\'s job)', () => {
    expect(stripErrorWrappers('Failed to fetch: Error: boom')).toBe('Failed to fetch: Error: boom');
  });

  test('trims surrounding whitespace before stripping', () => {
    expect(stripErrorWrappers('  Error: boom  ')).toBe('boom');
  });

  test('leaves an empty message empty', () => {
    expect(stripErrorWrappers('')).toBe('');
  });
});
