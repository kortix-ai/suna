import { describe, expect, test } from 'bun:test';

import { isSvgName } from './svg-policy';

describe('isSvgName', () => {
  test('names an SVG by its extension, case and spacing aside', () => {
    expect(isSvgName('mark.svg')).toBe(true);
    expect(isSvgName('/workspace/logo.SVG')).toBe(true);
    expect(isSvgName('  icon.svg  ')).toBe(true);
  });

  test('anything else is not one', () => {
    expect(isSvgName('chart.png')).toBe(false);
    expect(isSvgName('svg')).toBe(false);
    expect(isSvgName('notes.svg.md')).toBe(false);
    expect(isSvgName('')).toBe(false);
  });
});
