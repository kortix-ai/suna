import { describe, expect, test } from 'bun:test';

import {
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
  orderedDesktop,
  orderedMobile,
} from './detect-os';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

describe('detectPlatform', () => {
  test('reads each of the five platforms from a real user agent', () => {
    expect(detectPlatform(UA.mac)).toBe('macos');
    expect(detectPlatform(UA.windows)).toBe('windows');
    expect(detectPlatform(UA.linux)).toBe('linux');
    expect(detectPlatform(UA.iphone)).toBe('ios');
    expect(detectPlatform(UA.android)).toBe('android');
  });

  // The next two user agents each carry another platform's token. They are the
  // reason the checks in detectPlatform run in the order they do; reorder those
  // lines and these are the tests that fail.
  test('does not read an iPad as a Mac, though its UA contains "Mac OS X"', () => {
    expect(UA.ipad.toLowerCase()).toContain('mac');
    expect(detectPlatform(UA.ipad)).toBe('ios');
  });

  test('does not read an Android phone as desktop Linux, though its UA contains "Linux"', () => {
    expect(UA.android.toLowerCase()).toContain('linux');
    expect(detectPlatform(UA.android)).toBe('android');
  });

  test('falls back to macos for empty, null, and garbage user agents', () => {
    expect(detectPlatform('')).toBe('macos');
    expect(detectPlatform(null)).toBe('macos');
    expect(detectPlatform(undefined)).toBe('macos');
    expect(detectPlatform('curl/8.4.0')).toBe('macos');
  });
});

describe('normalizePlatform', () => {
  test('accepts every alias used by existing download links', () => {
    for (const alias of ['mac', 'macos', 'osx', 'darwin', 'apple', 'MacOS']) {
      expect(normalizePlatform(alias)).toBe('macos');
    }
    for (const alias of ['win', 'windows', 'WINDOWS']) {
      expect(normalizePlatform(alias)).toBe('windows');
    }
    expect(normalizePlatform('linux')).toBe('linux');
  });

  test('accepts the mobile aliases too', () => {
    for (const alias of ['ios', 'iphone', 'ipad', 'iOS']) {
      expect(normalizePlatform(alias)).toBe('ios');
    }
    expect(normalizePlatform('android')).toBe('android');
  });

  test('returns null for unknown platforms so callers can fall back', () => {
    expect(normalizePlatform('solaris')).toBeNull();
    expect(normalizePlatform('')).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
    expect(normalizePlatform(undefined)).toBeNull();
  });
});

describe('isMobilePlatform', () => {
  test('classifies which platforms are phones', () => {
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('android')).toBe(true);
    expect(isMobilePlatform('macos')).toBe(false);
    expect(isMobilePlatform('windows')).toBe(false);
    expect(isMobilePlatform('linux')).toBe(false);
  });
});

describe('orderedDesktop', () => {
  test('puts the detected OS first and keeps the rest in canonical order', () => {
    expect(orderedDesktop('windows')).toEqual(['windows', 'macos', 'linux']);
    expect(orderedDesktop('linux')).toEqual(['linux', 'macos', 'windows']);
    expect(orderedDesktop('macos')).toEqual(['macos', 'windows', 'linux']);
  });

  test('leaves the desktop order canonical when a phone is detected', () => {
    expect(orderedDesktop('ios')).toEqual(['macos', 'windows', 'linux']);
    expect(orderedDesktop('android')).toEqual(['macos', 'windows', 'linux']);
  });
});

describe('orderedMobile', () => {
  test('puts the detected mobile OS first', () => {
    expect(orderedMobile('android')).toEqual(['android', 'ios']);
    expect(orderedMobile('ios')).toEqual(['ios', 'android']);
  });

  test('leaves the mobile order canonical when a desktop OS is detected', () => {
    expect(orderedMobile('macos')).toEqual(['ios', 'android']);
    expect(orderedMobile('windows')).toEqual(['ios', 'android']);
    expect(orderedMobile('linux')).toEqual(['ios', 'android']);
  });
});
