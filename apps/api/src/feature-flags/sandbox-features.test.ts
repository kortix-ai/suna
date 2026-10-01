import { describe, expect, test } from 'bun:test';
import { sandboxFeaturesValue } from './sandbox-features';

describe('sandboxFeaturesValue', () => {
  test('flag on lists it', () => {
    expect(sandboxFeaturesValue({ experimental: { human_messaging: true } })).toBe('human_messaging');
  });
  test('flag off, default, or no metadata is never empty', () => {
    expect(sandboxFeaturesValue({ experimental: { human_messaging: false } })).toBe('none');
    expect(sandboxFeaturesValue({})).toBe('none');
    expect(sandboxFeaturesValue(null)).toBe('none');
  });
});
