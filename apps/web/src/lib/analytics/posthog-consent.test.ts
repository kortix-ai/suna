import { describe, expect, test } from 'bun:test';
import {
  captureAllowedNow,
  consentFromUpdate,
  hasKortixSession,
  parseCookieYesAnalytics,
  shouldCapture,
} from './posthog-consent';

const cky = (fields: string) => `cookieyes-consent=consentid:abc123,${fields}`;

describe('parseCookieYesAnalytics', () => {
  test('no CookieYes cookie → no decision', () => {
    expect(parseCookieYesAnalytics('')).toBeNull();
    expect(parseCookieYesAnalytics('other=1; sb-kortix-auth-token=x')).toBeNull();
  });

  test('opt-in region default (not answered, analytics:no) → no decision', () => {
    expect(parseCookieYesAnalytics(cky('consent:no,action:no,necessary:yes,analytics:no'))).toBeNull();
  });

  test('Accept All → yes; Reject All → no', () => {
    expect(parseCookieYesAnalytics(cky('consent:yes,action:yes,necessary:yes,functional:yes,analytics:yes,advertisement:yes'))).toBe('yes');
    expect(parseCookieYesAnalytics(cky('consent:no,action:yes,necessary:yes,functional:no,analytics:no,advertisement:no'))).toBe('no');
  });

  test('Customise with analytics off → no', () => {
    expect(parseCookieYesAnalytics(cky('consent:yes,action:yes,necessary:yes,functional:yes,analytics:no'))).toBe('no');
  });

  test('implied consent region (analytics:yes without an action) → yes', () => {
    expect(parseCookieYesAnalytics(cky('consent:yes,action:no,necessary:yes,analytics:yes'))).toBe('yes');
  });

  test('URL-encoded value and other cookies around it', () => {
    const header = `a=1; cookieyes-consent=${encodeURIComponent('consentid:x,consent:yes,action:yes,analytics:yes')}; b=2`;
    expect(parseCookieYesAnalytics(header)).toBe('yes');
  });
});

describe('consentFromUpdate', () => {
  test('reads the accepted / rejected category lists', () => {
    expect(consentFromUpdate({ accepted: ['necessary', 'analytics'], rejected: [] })).toBe('yes');
    expect(consentFromUpdate({ accepted: ['necessary'], rejected: ['analytics', 'advertisement'] })).toBe('no');
    expect(consentFromUpdate({ accepted: ['necessary'], rejected: [] })).toBeNull();
    expect(consentFromUpdate(undefined)).toBeNull();
  });
});

describe('hasKortixSession', () => {
  test('plain, port-suffixed and chunked auth cookies', () => {
    expect(hasKortixSession('sb-kortix-auth-token=base64-x')).toBe(true);
    expect(hasKortixSession('foo=1; sb-kortix-auth-token-3000=base64-x')).toBe(true);
    expect(hasKortixSession('sb-kortix-auth-token-13500.0=part; sb-kortix-auth-token-13500.1=part')).toBe(true);
    expect(hasKortixSession('sb-kortix-auth-token-code-verifier=x')).toBe(false);
    expect(hasKortixSession('')).toBe(false);
  });
});

describe('shouldCapture', () => {
  test('explicit no wins everywhere', () => {
    expect(shouldCapture({ signedIn: true, consent: 'no' })).toBe(false);
    expect(shouldCapture({ signedIn: false, consent: 'no' })).toBe(false);
  });
  test('yes allows capture', () => {
    expect(shouldCapture({ signedIn: false, consent: 'yes' })).toBe(true);
    expect(shouldCapture({ signedIn: true, consent: 'yes' })).toBe(true);
  });
  test('no decision: only signed-in users', () => {
    expect(shouldCapture({ signedIn: true, consent: null })).toBe(true);
    expect(shouldCapture({ signedIn: false, consent: null })).toBe(false);
  });
});

describe('captureAllowedNow', () => {
  test('anonymous visitor without a decision is not captured', () => {
    expect(captureAllowedNow('')).toBe(false);
  });
  test('anonymous visitor who accepted is captured', () => {
    expect(captureAllowedNow(cky('consent:yes,action:yes,analytics:yes'))).toBe(true);
  });
  test('signed-in user without a decision is captured; after Reject All is not', () => {
    expect(captureAllowedNow('sb-kortix-auth-token-3000=x')).toBe(true);
    expect(captureAllowedNow(`sb-kortix-auth-token-3000=x; ${cky('consent:no,action:yes,analytics:no')}`)).toBe(false);
  });
});
