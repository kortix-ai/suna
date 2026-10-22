import { describe, expect, test } from 'bun:test';
import { stripCaretAnsi } from './structured-output';
import { trimTrailingSlashes } from '../../../session/panel/shared/derive-panels';

// The regexes these replace; CodeQL js/polynomial-redos flagged both.
const oldStrip = (s: string) => s.replace(/\^+\[[\d;]*[A-Za-z]/g, '');
const oldTrim = (s: string) => s.replace(/\/+$/, '');

describe('stripCaretAnsi', () => {
  test('matches the old regex on caret-rendered escapes and plain text', () => {
    for (const sample of [
      'ok ^[[0m done',
      '^^[1;31mred^[[0m',
      'a ^ b ^^ c',
      '^[x',
      '^[12;',
      '^[[',
      'no carets here',
      '',
      '^^^^',
      'x^[;mY',
    ]) {
      expect(stripCaretAnsi(sample)).toBe(oldStrip(sample));
    }
  });

  test('stays linear on a long caret run that no escape closes', () => {
    const input = `${'^'.repeat(100_000)}x`;
    const start = performance.now();
    expect(stripCaretAnsi(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('trimTrailingSlashes', () => {
  test('matches the old regex', () => {
    for (const sample of ['a/b/', 'a/b///', '/', '', 'a', 'https://x.com//']) {
      expect(trimTrailingSlashes(sample)).toBe(oldTrim(sample));
    }
  });

  test('stays linear on a long slash run that does not end the string', () => {
    const input = `${'/'.repeat(100_000)}x`;
    const start = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
