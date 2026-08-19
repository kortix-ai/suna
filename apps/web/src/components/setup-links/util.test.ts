import { afterEach, describe, expect, test } from 'bun:test';

import { HostBoundaryError } from '@kortix/sdk';
import {
  classifySetupLinkError,
  describeLinkExpiry,
  parseSetupLinkHref,
  setupLinkChipLabel,
} from './util';

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

describe('classifySetupLinkError', () => {
  test('410 means expired — the recoverable, expected state', () => {
    expect(classifySetupLinkError(new HostBoundaryError('This link has expired', 410, null))).toBe(
      'expired',
    );
  });

  test('404 and 400 mean the link itself is bad (truncated copy, wrong type)', () => {
    expect(
      classifySetupLinkError(new HostBoundaryError('Invalid or unknown link', 404, null)),
    ).toBe('invalid');
    expect(classifySetupLinkError(new HostBoundaryError('Wrong link type', 400, null))).toBe(
      'invalid',
    );
  });

  test('status carried structurally (no instanceof) still classifies', () => {
    expect(classifySetupLinkError({ status: 410 })).toBe('expired');
    expect(classifySetupLinkError({ status: 404 })).toBe('invalid');
  });

  test('anything without a known status is a network problem', () => {
    expect(classifySetupLinkError(new TypeError('fetch failed'))).toBe('network');
    expect(classifySetupLinkError(new HostBoundaryError('rate limited', 429, null))).toBe(
      'network',
    );
    expect(classifySetupLinkError(undefined)).toBe('network');
  });
});

describe('describeLinkExpiry', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');

  test('rounds to the largest sensible unit', () => {
    expect(describeLinkExpiry('2026-08-14T12:00:00.000Z', now)).toBe('7 days');
    expect(describeLinkExpiry('2026-08-07T17:00:00.000Z', now)).toBe('5 hours');
    expect(describeLinkExpiry('2026-08-07T12:25:00.000Z', now)).toBe('25 minutes');
    expect(describeLinkExpiry('2026-08-07T12:01:00.000Z', now)).toBe('less than 2 minutes');
  });

  test('past or unparseable expiry yields null', () => {
    expect(describeLinkExpiry('2026-08-07T11:00:00.000Z', now)).toBeNull();
    expect(describeLinkExpiry('not-a-date', now)).toBeNull();
  });
});
