import { describe, expect, test } from 'bun:test';
import { resolveShareLinkUrl } from './share-link';

describe('resolveShareLinkUrl', () => {
  test('keeps an https kortix.com share link as-is', () => {
    expect(resolveShareLinkUrl('https://kortix.com/share/abc')).toBe(
      'https://kortix.com/share/abc',
    );
  });

  test('preserves the www host and the query string', () => {
    expect(resolveShareLinkUrl('https://www.kortix.com/share/abc?x=1')).toBe(
      'https://www.kortix.com/share/abc?x=1',
    );
  });

  test('preserves staging, nested paths and the fragment', () => {
    expect(resolveShareLinkUrl('https://staging.kortix.com/share/session/tok?x=1#m2')).toBe(
      'https://staging.kortix.com/share/session/tok?x=1#m2',
    );
  });

  test('matches the host case-insensitively', () => {
    expect(resolveShareLinkUrl('https://Kortix.com/share/abc')).toBe(
      'https://kortix.com/share/abc',
    );
  });

  test('maps the custom scheme onto kortix.com', () => {
    expect(resolveShareLinkUrl('kortix://share/abc')).toBe('https://kortix.com/share/abc');
    expect(resolveShareLinkUrl('kortix://share/abc?x=1')).toBe(
      'https://kortix.com/share/abc?x=1',
    );
    expect(resolveShareLinkUrl('kortix:///share/abc')).toBe('https://kortix.com/share/abc');
  });

  test('returns null for non-share links', () => {
    expect(resolveShareLinkUrl('https://kortix.com/auth/callback?mobile_callback=1')).toBeNull();
    expect(resolveShareLinkUrl('https://kortix.com/')).toBeNull();
    expect(resolveShareLinkUrl('https://kortix.com/shared/abc')).toBeNull();
    expect(resolveShareLinkUrl('kortix://auth/callback?code=1')).toBeNull();
    expect(resolveShareLinkUrl('kortix://connections')).toBeNull();
    expect(resolveShareLinkUrl('not a url')).toBeNull();
    expect(resolveShareLinkUrl('')).toBeNull();
  });

  test('returns null for a share path without an id', () => {
    expect(resolveShareLinkUrl('https://kortix.com/share')).toBeNull();
    expect(resolveShareLinkUrl('https://kortix.com/share/')).toBeNull();
    expect(resolveShareLinkUrl('kortix://share')).toBeNull();
    expect(resolveShareLinkUrl('kortix://share/')).toBeNull();
  });

  test('returns null for foreign hosts and schemes', () => {
    expect(resolveShareLinkUrl('https://evil.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('https://kortix.com.evil.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('https://user@kortix.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('http://kortix.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('exp://127.0.0.1:8081/--/share/abc')).toBeNull();
  });
});
