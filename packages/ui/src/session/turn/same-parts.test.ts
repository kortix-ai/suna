import { describe, expect, test } from 'bun:test';
import { samePartsList } from './same-parts';

describe('samePartsList', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };

  test('the same array is equal without looking at it', () => {
    const list = [a, b];
    expect(samePartsList(list, list)).toBe(true);
  });

  test('a NEW array of the same parts is equal — this is the whole point', () => {
    // While a turn streams, `segmentTurn` rebuilds every burst's array each
    // frame. Identity comparison would miss on all of them; element-wise does
    // not, so an unchanged burst skips its subtree.
    expect(samePartsList([a, b], [a, b])).toBe(true);
  });

  test('a replaced part is not equal', () => {
    // A part object is replaced when it changes, which is the signal to re-render.
    expect(samePartsList([a, b], [a, { id: 'b' }])).toBe(false);
  });

  test('a shorter or longer list is not equal', () => {
    expect(samePartsList([a], [a, b])).toBe(false);
    expect(samePartsList([a, b], [a])).toBe(false);
  });

  test('order matters', () => {
    expect(samePartsList([a, b], [b, a])).toBe(false);
  });

  test('two empty lists are equal', () => {
    expect(samePartsList([], [])).toBe(true);
  });
});
