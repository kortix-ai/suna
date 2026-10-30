import { describe, expect, test } from 'bun:test';
import { SpaceLinkCreateInputSchema } from '../index';

describe('SpaceLinkCreateInputSchema.url', () => {
  test('the 2,048-character limit applies to the URL as stored, after encoding', () => {
    // Each inner space encodes to %20: 2,000 of them grow the stored href to about 6,000 characters.
    const spaces = `https://example.test/a${' '.repeat(2000)}b`;
    expect(spaces.length).toBeLessThanOrEqual(2048);
    expect(SpaceLinkCreateInputSchema.safeParse({ url: spaces }).success).toBe(false);
    const atLimit = `https://example.test/${'a'.repeat(2048 - 'https://example.test/'.length)}`;
    expect(SpaceLinkCreateInputSchema.safeParse({ url: atLimit }).success).toBe(true);
    expect(SpaceLinkCreateInputSchema.safeParse({ url: `${atLimit}a` }).success).toBe(false);
  });

  test('only http and https URLs pass', () => {
    expect(SpaceLinkCreateInputSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(SpaceLinkCreateInputSchema.safeParse({ url: 'not a url' }).success).toBe(false);
  });
});
