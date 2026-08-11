import { describe, expect, test } from 'bun:test';

import { parseSidebarStateCookie } from './sidebar-cookie';

describe('parseSidebarStateCookie', () => {
  test('reads a collapsed sidebar', () => {
    expect(parseSidebarStateCookie('sidebar_state=false')).toBe(false);
  });

  test('reads an expanded sidebar', () => {
    expect(parseSidebarStateCookie('sidebar_state=true')).toBe(true);
  });

  test('finds the value among other cookies', () => {
    expect(parseSidebarStateCookie('foo=1; sidebar_state=false; bar=baz')).toBe(false);
    expect(parseSidebarStateCookie('theme=dark;sidebar_state=true')).toBe(true);
  });

  test('returns undefined when the cookie is absent so the default applies', () => {
    expect(parseSidebarStateCookie('foo=1; bar=2')).toBeUndefined();
    expect(parseSidebarStateCookie('')).toBeUndefined();
    expect(parseSidebarStateCookie(null)).toBeUndefined();
    expect(parseSidebarStateCookie(undefined)).toBeUndefined();
  });

  test('does not match a different cookie that ends with sidebar_state', () => {
    expect(parseSidebarStateCookie('x_sidebar_state=true')).toBeUndefined();
  });

  test('ignores non-boolean values', () => {
    expect(parseSidebarStateCookie('sidebar_state=maybe')).toBeUndefined();
  });
});
