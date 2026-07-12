import { afterEach, describe, expect, test } from 'bun:test';

import { parseSetupLinkHref, setupLinkChipLabel } from './util';

const TOKEN = `ksl_${'A'.repeat(400)}`;

function withWindowOrigin(origin: string) {
  (globalThis as any).window = { location: { origin } };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('parseSetupLinkHref', () => {
  test('parses a same-origin secret-intake URL', () => {
    withWindowOrigin('https://kortix.com');
    expect(parseSetupLinkHref(`https://kortix.com/secret-intake/${TOKEN}`)).toEqual({
      kind: 'secret',
      token: TOKEN,
    });
  });

  test('parses a relative connect path', () => {
    expect(parseSetupLinkHref(`/connect/${TOKEN}`)).toEqual({
      kind: 'connector',
      token: TOKEN,
    });
  });

  test('cross-origin ksl_ links are still intercepted (FRONTEND_URL ≠ app origin)', () => {
    withWindowOrigin('https://staging.kortix.com');
    expect(parseSetupLinkHref(`https://kortix.com/secret-intake/${TOKEN}`)).toEqual({
      kind: 'secret',
      token: TOKEN,
    });
  });

  test('cross-origin non-ksl paths stay plain links', () => {
    withWindowOrigin('https://kortix.com');
    expect(parseSetupLinkHref('https://example.com/connect/some-other-token')).toBeNull();
  });

  test('unrelated URLs are ignored', () => {
    expect(parseSetupLinkHref('https://kortix.com/docs')).toBeNull();
    expect(parseSetupLinkHref('/projects/p1')).toBeNull();
    expect(parseSetupLinkHref(undefined)).toBeNull();
  });
});

describe('setupLinkChipLabel', () => {
  test('a raw URL as link text falls back to the friendly label', () => {
    expect(
      setupLinkChipLabel(`https://kortix.com/secret-intake/${TOKEN}`, TOKEN, 'Enter credentials'),
    ).toBe('Enter credentials');
  });

  test('link text containing the token falls back', () => {
    expect(setupLinkChipLabel(`secret-intake/${TOKEN}`, TOKEN, 'Enter credentials')).toBe(
      'Enter credentials',
    );
  });

  test('a long unbroken string falls back', () => {
    expect(setupLinkChipLabel('x'.repeat(80), TOKEN, 'Connect app')).toBe('Connect app');
  });

  test('empty text falls back', () => {
    expect(setupLinkChipLabel('  ', TOKEN, 'Connect app')).toBe('Connect app');
  });

  test('a human-authored label is kept', () => {
    expect(setupLinkChipLabel('Enter your Slack credentials', TOKEN, 'Enter credentials')).toBe(
      'Enter your Slack credentials',
    );
  });
});
