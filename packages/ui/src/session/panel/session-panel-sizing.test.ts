import { expect, test } from 'bun:test';
import { aspectChangedWidth, fitSplitPercent, resolveSideSize } from './easy/easy-panel-logic';

test('sizing precedence, finite guards, bounds and drag tolerance stay stable', () => {
  const panelBox = { width: 1000, height: 548 };
  const input = { isExpanded: false, isEasy: true, panelAspect: 1, panelSplit: 70, panelBox };
  expect(resolveSideSize(input)).toBe(54.800000000000004);
  expect(resolveSideSize({ ...input, isExpanded: true, isEasy: false })).toBe(100);
  expect(resolveSideSize({ ...input, isEasy: false })).toBe(50);
  expect(resolveSideSize({ ...input, panelAspect: null })).toBe(70);
  expect(resolveSideSize({ ...input, panelBox: null, panelSplit: null })).toBe(35);
  for (const aspect of [0, -1, NaN, Infinity]) {
    expect(fitSplitPercent({ aspect, layoutWidth: 1000, panelContentHeight: 500 })).toBeNull();
  }
  expect(fitSplitPercent({ aspect: 0.1, layoutWidth: 1000, panelContentHeight: 500 })).toBe(35);
  expect(fitSplitPercent({ aspect: 10, layoutWidth: 1000, panelContentHeight: 500 })).toBe(70);
  expect(aspectChangedWidth({ prevAspect: 1, nextAspect: 2, currentSize: 50, nextSize: 50.5 })).toBe(false);
  expect(aspectChangedWidth({ prevAspect: 1, nextAspect: 2, currentSize: 50, nextSize: 50.51 })).toBe(true);
  expect(aspectChangedWidth({ prevAspect: 1, nextAspect: 2, currentSize: NaN, nextSize: 50 })).toBe(true);
});
