import { describe, expect, test } from 'bun:test';

import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_WIDTH_PX,
  clampSidebarWidth,
  maxSidebarWidth,
  parseSidebarWidthCookie,
} from './sidebar-width';

describe('maxSidebarWidth', () => {
  test('the 32% ratio governs on narrow viewports', () => {
    expect(maxSidebarWidth(1024)).toBe(327);
  });

  test('the absolute ceiling governs on wide viewports', () => {
    expect(maxSidebarWidth(1600)).toBe(SIDEBAR_MAX_WIDTH_PX);
    expect(maxSidebarWidth(2560)).toBe(SIDEBAR_MAX_WIDTH_PX);
  });

  test('never returns a max below the min, so the range cannot invert', () => {
    expect(maxSidebarWidth(320)).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(maxSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH_PX);
  });
});

describe('clampSidebarWidth', () => {
  test('holds a width inside the range untouched', () => {
    expect(clampSidebarWidth(300, 1440)).toBe(300);
  });

  test('clamps to the min and to the viewport-derived max', () => {
    expect(clampSidebarWidth(40, 1440)).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(clampSidebarWidth(9999, 1024)).toBe(327);
    expect(clampSidebarWidth(9999, 1920)).toBe(SIDEBAR_MAX_WIDTH_PX);
  });

  test('snaps onto the default width from either side', () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_PX - 11, 1440)).toBe(SIDEBAR_WIDTH_PX);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_PX + 11, 1440)).toBe(SIDEBAR_WIDTH_PX);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_PX + 40, 1440)).toBe(SIDEBAR_WIDTH_PX + 40);
  });

  test('the snap can never pull a value outside the range', () => {
    // 320px viewport caps the max at the min; the snap target sits above it.
    expect(clampSidebarWidth(SIDEBAR_WIDTH_PX, 320)).toBe(SIDEBAR_MIN_WIDTH_PX);
  });

  test('always returns an integer', () => {
    expect(clampSidebarWidth(300.6, 1440)).toBe(301);
  });
});

describe('parseSidebarWidthCookie', () => {
  test('reads the width the provider writes', () => {
    expect(parseSidebarWidthCookie('sidebar_state=true; sidebar_width=312')).toBe(312);
    expect(parseSidebarWidthCookie('sidebar_width=208')).toBe(208);
  });

  test('returns null rather than NaN for absent or junk values', () => {
    expect(parseSidebarWidthCookie('')).toBeNull();
    expect(parseSidebarWidthCookie(null)).toBeNull();
    expect(parseSidebarWidthCookie('sidebar_state=true')).toBeNull();
    expect(parseSidebarWidthCookie('sidebar_width=abc')).toBeNull();
    expect(parseSidebarWidthCookie('sidebar_width=')).toBeNull();
  });

  test('does not match a cookie that merely ends in sidebar_width', () => {
    expect(parseSidebarWidthCookie('x_sidebar_width=999')).toBeNull();
  });
});
