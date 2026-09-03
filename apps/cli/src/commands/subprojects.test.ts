import { describe, expect, test } from 'bun:test';

import { takeFlagValue } from '../command-helpers.ts';
import {
  buildCreateBody,
  buildUpdateBody,
  expiresAtEndOfDay,
  readInstructionsFlag,
  resolveOptionalField,
  validateSessionsMode,
} from './subprojects.ts';

describe('takeFlagValue — explicit empty value', () => {
  test('an explicit empty value via --flag= is returned, not treated as missing', () => {
    const argv = ['--subproject='];
    expect(takeFlagValue(argv, ['--subproject'])).toBe('');
    expect(argv).toEqual([]);
  });

  test('an explicit empty value via --flag "" is returned, not treated as missing', () => {
    const argv = ['--subproject', ''];
    expect(takeFlagValue(argv, ['--subproject'])).toBe('');
    expect(argv).toEqual([]);
  });

  test('a genuinely missing value (end of argv) still throws', () => {
    expect(() => takeFlagValue(['--subproject'], ['--subproject'])).toThrow(
      '--subproject requires a value',
    );
  });

  test('a missing value followed by another flag still throws', () => {
    expect(() => takeFlagValue(['--subproject', '--json'], ['--subproject'])).toThrow(
      '--subproject requires a value',
    );
  });
});

describe('buildCreateBody', () => {
  test('required name only', () => {
    expect(buildCreateBody('Marketing', { context: [] })).toEqual({ name: 'Marketing' });
  });

  test('every optional field, slugified explicitly', () => {
    expect(
      buildCreateBody('Marketing', {
        slug: 'mktg',
        description: 'Campaign work.',
        agent: 'writer',
        instructions: 'Always write in British English.\n',
        context: ['docs/brand.md', '.kortix/subprojects/mktg/'],
        sessions: 'shared',
      }),
    ).toEqual({
      name: 'Marketing',
      slug: 'mktg',
      description: 'Campaign work.',
      agent: 'writer',
      instructions: 'Always write in British English.\n',
      context: ['docs/brand.md', '.kortix/subprojects/mktg/'],
      sessions: 'shared',
    });
  });

  test('an empty --context list is omitted, not sent as []', () => {
    expect(buildCreateBody('X', { context: [] })).toEqual({ name: 'X' });
  });
});

describe('buildUpdateBody', () => {
  test('only the fields the caller named are sent', () => {
    expect(buildUpdateBody({ description: 'new desc' })).toEqual({ description: 'new desc' });
  });

  test('an empty flag clears the field to null', () => {
    expect(
      buildUpdateBody({
        description: resolveOptionalField(''),
        agent: resolveOptionalField(''),
      }),
    ).toEqual({ description: null, agent: null });
  });

  test('an omitted flag is left out of the body entirely', () => {
    expect(buildUpdateBody({ name: resolveOptionalField(undefined) })).toEqual({});
  });

  test('context replaces the whole list when passed', () => {
    expect(buildUpdateBody({ context: ['a.md', 'b.md'] })).toEqual({ context: ['a.md', 'b.md'] });
  });

  test('a no-op update produces an empty body', () => {
    expect(buildUpdateBody({})).toEqual({});
  });
});

describe('resolveOptionalField', () => {
  test('undefined (not passed) stays undefined — omit', () => {
    expect(resolveOptionalField(undefined)).toBeUndefined();
  });
  test('empty string (explicit clear) becomes null', () => {
    expect(resolveOptionalField('')).toBeNull();
  });
  test('a real value passes through unchanged', () => {
    expect(resolveOptionalField('writer')).toBe('writer');
  });
});

describe('readInstructionsFlag', () => {
  test('undefined stays undefined — omit', () => {
    expect(readInstructionsFlag(undefined)).toBeUndefined();
  });
  test('empty string clears — null', () => {
    expect(readInstructionsFlag('')).toBeNull();
  });
});

describe('validateSessionsMode', () => {
  test('undefined is left unvalidated (omit)', () => {
    expect(validateSessionsMode(undefined)).toBeUndefined();
  });
  test('private and shared are accepted', () => {
    expect(validateSessionsMode('private')).toBe('private');
    expect(validateSessionsMode('shared')).toBe('shared');
  });
  test('anything else is rejected', () => {
    expect(validateSessionsMode('public')).toEqual({
      error: '--sessions must be private or shared (got "public").',
    });
  });
});

describe('expiresAtEndOfDay', () => {
  test('a valid date becomes end-of-day UTC', () => {
    expect(expiresAtEndOfDay('2026-12-31')).toBe('2026-12-31T23:59:59.999Z');
  });
  test('a malformed date is rejected', () => {
    expect(expiresAtEndOfDay('12/31/2026')).toEqual({
      error: '--expires must be YYYY-MM-DD.',
    });
  });
  test('an out-of-range date is rejected', () => {
    expect(expiresAtEndOfDay('2026-13-40')).toEqual({
      error: '--expires must be YYYY-MM-DD.',
    });
  });
});
