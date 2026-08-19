import { describe, expect, test } from 'bun:test';

import {
  AT_END_PX,
  BOTTOM_GAP_PX,
  CHEVRON_PX,
  TURN_TOP_OFFSET,
  chevronVisible,
  isAtEnd,
  roomUnderNewestTurn,
} from './use-auto-scroll';

describe('roomUnderNewestTurn — FACT 1, the room is one value streaming or idle', () => {
  test('enough room for the anchor turn to sit at TURN_TOP_OFFSET', () => {
    expect(roomUnderNewestTurn(800, 100)).toBe(800 - 100 - TURN_TOP_OFFSET);
  });
  test('floored at BOTTOM_GAP_PX for a turn taller than the viewport', () => {
    expect(roomUnderNewestTurn(800, 2000)).toBe(BOTTOM_GAP_PX);
    expect(roomUnderNewestTurn(800, 800 - TURN_TOP_OFFSET)).toBe(BOTTOM_GAP_PX);
  });
  test('a transcript with no turn yet reserves the whole viewport', () => {
    expect(roomUnderNewestTurn(800, null)).toBe(800);
  });
});

describe('isAtEnd — THE RULE resumes only at the end', () => {
  test('within AT_END_PX counts as at the end (drags rarely land on the pixel)', () => {
    expect(isAtEnd(0)).toBe(true);
    expect(isAtEnd(AT_END_PX)).toBe(true);
    expect(isAtEnd(-3)).toBe(true);
  });
  test('anything further is away — a jittery wheel tick never re-arms follow', () => {
    expect(isAtEnd(AT_END_PX + 1)).toBe(false);
    expect(isAtEnd(80)).toBe(false);
  });
});

describe('chevronVisible — measured in CONTENT, the room excluded', () => {
  test('hidden while the reader is only a little way up', () => {
    expect(chevronVisible(CHEVRON_PX)).toBe(false);
    expect(chevronVisible(0)).toBe(false);
  });
  test('shown once meaningfully away from the end of the content', () => {
    expect(chevronVisible(CHEVRON_PX + 1)).toBe(true);
  });
});
