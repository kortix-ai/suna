import { describe, expect, test } from 'bun:test';

import {
  authCookieOptions,
  EXTENSION_ORIGIN,
  hasPanelMarker,
  isExtensionPanelFrame,
  panelAuthUrl,
  safePanelNext,
} from './panel-cookies';

describe('authCookieOptions', () => {
  test('a normal tab keeps Lax and the caller secure flag', () => {
    expect(authCookieOptions(false, false)).toEqual({ path: '/', sameSite: 'lax', secure: false });
    expect(authCookieOptions(false, true)).toEqual({ path: '/', sameSite: 'lax', secure: true });
  });
  test('the panel is None, Secure and Partitioned whatever the protocol', () => {
    expect(authCookieOptions(true, false)).toEqual({ path: '/', sameSite: 'none', secure: true, partitioned: true });
  });
});

describe('isExtensionPanelFrame', () => {
  test('framed by the extension: ancestorOrigins decides', () => {
    expect(isExtensionPanelFrame([EXTENSION_ORIGIN], '', true)).toBe(true);
    expect(isExtensionPanelFrame(['https://example.com'], `${EXTENSION_ORIGIN}/sidepanel.html`, true)).toBe(false);
    expect(isExtensionPanelFrame(['chrome-extension://otherextensionid'], '', true)).toBe(false);
  });
  test('without ancestorOrigins the referrer is the fallback', () => {
    expect(isExtensionPanelFrame(undefined, `${EXTENSION_ORIGIN}/sidepanel.html`, true)).toBe(true);
    expect(isExtensionPanelFrame(undefined, `${EXTENSION_ORIGIN}evil.example/`, true)).toBe(false);
    expect(isExtensionPanelFrame(undefined, 'https://example.com/', true)).toBe(false);
  });
  test('a top-level page is never the panel', () => {
    expect(isExtensionPanelFrame([EXTENSION_ORIGIN], `${EXTENSION_ORIGIN}/x`, false)).toBe(false);
  });
});

describe('hasPanelMarker', () => {
  const jar = (value?: string) => ({ get: (name: string) => (name === 'kortix_panel' && value ? { value } : undefined) });
  test('only kortix_panel=1', () => {
    expect(hasPanelMarker(jar('1'))).toBe(true);
    expect(hasPanelMarker(jar('0'))).toBe(false);
    expect(hasPanelMarker(jar())).toBe(false);
  });
});

describe('safePanelNext', () => {
  test('keeps same-origin relative paths', () => {
    expect(safePanelNext('/projects/abc?tab=1')).toBe('/projects/abc?tab=1');
  });
  test.each([null, undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'projects', '/auth', '/auth/panel?next=/x', '/auth?redirect=/x'])(
    'falls back to /projects for %p',
    (value) => {
      expect(safePanelNext(value as string | null)).toBe('/projects');
    },
  );
  test('panelAuthUrl encodes the target', () => {
    expect(panelAuthUrl('/projects/a?b=1')).toBe('/auth/panel?next=%2Fprojects%2Fa%3Fb%3D1');
  });
});
