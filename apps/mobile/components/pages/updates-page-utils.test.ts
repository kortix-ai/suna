import { describe, expect, test } from 'bun:test';
import { normalizeReleaseTitle } from './updates-page-utils';

describe('normalizeReleaseTitle', () => {
  test('removes the literal stable version prefix', () => {
    expect(normalizeReleaseTitle('v1.2.3 — Better sessions', '1.2.3')).toBe('Better sessions');
  });

  test('treats every regex metacharacter in a version as literal text', () => {
    const version = String.raw`1.2.3+edge[one](x){2}\\candidate`;
    expect(normalizeReleaseTitle(`v${version}: Exact match`, version)).toBe('Exact match');
    expect(normalizeReleaseTitle('v1x2x3+edgeone: Different text', version)).toBe(
      'v1x2x3+edgeone: Different text',
    );
  });
});
