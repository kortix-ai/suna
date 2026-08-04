import { describe, expect, test } from 'bun:test';

import {
  TRANSCRIPT_ESTIMATED_TURN_HEIGHT,
  findTurnIndexById,
  renderedTurnIdsKey,
} from './turn-virtualizer';

const turn = (id: string) => ({ userMessage: { info: { id } } });

describe('findTurnIndexById', () => {
  const turns = [turn('u1'), turn('u2'), turn('u3')];

  test('finds a turn by its user message id', () => {
    expect(findTurnIndexById(turns, 'u2')).toBe(1);
  });

  // Returning 0 here would silently scroll the reader to the top of the
  // thread instead of reporting "no such turn".
  test('returns -1 for an unknown id, never 0', () => {
    expect(findTurnIndexById(turns, 'nope')).toBe(-1);
  });

  test('returns -1 for a null or empty id rather than throwing', () => {
    expect(findTurnIndexById(turns, null)).toBe(-1);
    expect(findTurnIndexById(turns, undefined)).toBe(-1);
    expect(findTurnIndexById(turns, '')).toBe(-1);
  });

  test('returns -1 on an empty thread', () => {
    expect(findTurnIndexById([], 'u1')).toBe(-1);
  });
});

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

describe('TRANSCRIPT_ESTIMATED_TURN_HEIGHT', () => {
  // Inherited from the `contain-intrinsic-size:auto_600px` the transcript
  // already used, so the virtualizer's first guess matches what the browser
  // was already assuming rather than being a fresh invention.
  test('matches the contain-intrinsic-size the CSS already used', () => {
    expect(TRANSCRIPT_ESTIMATED_TURN_HEIGHT).toBe(600);
  });
});
