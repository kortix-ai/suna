import { describe, expect, test } from 'bun:test';

import { detentsKey, withFullDetent } from './sheet-detents';

describe('withFullDetent', () => {
  test('a sheet without detents (content-sized) gets the full detent', () => {
    expect(withFullDetent(undefined)).toEqual(['100%']);
  });

  test('a sheet that opens at 92% keeps 92% first and can expand to 100%', () => {
    expect(withFullDetent(['92%'])).toEqual(['92%', '100%']);
  });

  test('a two-stop sheet keeps its order', () => {
    expect(withFullDetent(['40%', '85%'])).toEqual(['40%', '85%', '100%']);
  });

  test('a pixel detent works too', () => {
    expect(withFullDetent([320])).toEqual([320, '100%']);
  });

  test('a sheet that already reaches 100% is returned as-is', () => {
    const detents = ['85%', '100%'];
    expect(withFullDetent(detents)).toBe(detents);
    expect(withFullDetent(['100%'])).toEqual(['100%']);
  });

  test('a shared value passes through untouched', () => {
    const shared = { value: ['50%'] };
    expect(withFullDetent(shared)).toBe(shared);
  });
});

describe('detentsKey', () => {
  test('two equal inline arrays share one key', () => {
    expect(detentsKey(['92%'])).toBe(detentsKey(['92%']));
    expect(detentsKey(['40%', '85%'])).not.toBe(detentsKey(['85%', '40%']));
  });

  test('undefined and shared values are their own key', () => {
    expect(detentsKey(undefined)).toBeUndefined();
    const shared = { value: ['50%'] };
    expect(detentsKey(shared)).toBe(shared);
  });
});
