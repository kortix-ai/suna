// WHOSE AUTHORITY A CELL SPEAKS WITH.
//
// On a shared cell host the box's key belongs to whichever session created it.
// Written into every cell, it made every other session relay its turn end with
// a stranger's token: 403 from /turn-stream, the ledger record left open, and
// the next prompt on that session waiting behind `turn_active` forever.
import { describe, expect, test } from 'bun:test';
import { cellEnvToken } from './cell-env-token';

describe('the token written into a cell', () => {
  test("is the SESSION's, even when a box key was handed in", () => {
    expect(cellEnvToken('sess_key', 'box_key')).toBe('sess_key');
  });

  test('falls back to the box key only when the session has none', () => {
    expect(cellEnvToken(undefined, 'box_key')).toBe('box_key');
    expect(cellEnvToken(null, 'box_key')).toBe('box_key');
  });

  test('treats a blank session key as no key — a cell must never carry ""', () => {
    expect(cellEnvToken('   ', 'box_key')).toBe('box_key');
  });

  test('is null when neither exists, rather than an empty bearer', () => {
    expect(cellEnvToken(null, null)).toBeNull();
    expect(cellEnvToken('', '  ')).toBeNull();
  });

  test('trims, because a token with a newline is a 401 nobody can see', () => {
    expect(cellEnvToken(' sess_key\n', 'box_key')).toBe('sess_key');
  });
});
