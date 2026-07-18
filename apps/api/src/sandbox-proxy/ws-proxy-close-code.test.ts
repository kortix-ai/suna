import { describe, expect, test } from 'bun:test';

import { sanitizePreviewWsCloseCode } from './ws-proxy';

describe('sanitizePreviewWsCloseCode', () => {
  test('preserves standard server error and restart close codes', () => {
    expect(sanitizePreviewWsCloseCode(1011)).toBe(1011);
    expect(sanitizePreviewWsCloseCode(1012)).toBe(1012);
  });

  test('maps reserved wire-only codes to an application error code', () => {
    expect(sanitizePreviewWsCloseCode(1005)).toBe(4500);
    expect(sanitizePreviewWsCloseCode(1006)).toBe(4500);
    expect(sanitizePreviewWsCloseCode(undefined)).toBe(4500);
  });
});
