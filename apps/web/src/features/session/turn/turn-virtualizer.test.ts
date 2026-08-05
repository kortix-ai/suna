import { describe, expect, test } from 'bun:test';

import { renderedTurnIdsKey } from './turn-virtualizer';

describe('renderedTurnIdsKey', () => {
  test('is stable for identical input', () => {
    expect(renderedTurnIdsKey(['a', 'b'])).toBe(renderedTurnIdsKey(['a', 'b']));
  });

  test('is order-sensitive, so a scrolled window is a different key', () => {
    expect(renderedTurnIdsKey(['a', 'b'])).not.toBe(renderedTurnIdsKey(['b', 'a']));
  });

  test('distinguishes a grown window from a shrunk one', () => {
    expect(renderedTurnIdsKey(['a', 'b'])).not.toBe(renderedTurnIdsKey(['a', 'b', 'c']));
  });

  test('handles the empty window', () => {
    expect(renderedTurnIdsKey([])).toBe('');
  });
});
