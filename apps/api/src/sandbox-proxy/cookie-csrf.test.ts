import { describe, expect, test } from 'bun:test';
import { isCookieCsrfRefused } from './cookie-csrf';

const COOKIE = '__preview_session=abc';
const refused = (method: string, headers: Record<string, string>) =>
  isCookieCsrfRefused({ method, headers: new Headers(headers) });

describe('isCookieCsrfRefused', () => {
  test('a cookie-only write from a same-site sibling or another site is refused', () => {
    expect(refused('POST', { cookie: COOKIE, 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(refused('POST', { cookie: COOKIE, 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(refused('DELETE', { cookie: COOKIE, 'sec-fetch-site': 'same-site' })).toBe(true);
  });

  test('a same-origin write, a typed URL, and a read pass', () => {
    expect(refused('POST', { cookie: COOKIE, 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(refused('POST', { cookie: COOKIE, 'sec-fetch-site': 'none' })).toBe(false);
    expect(refused('GET', { cookie: COOKIE, 'sec-fetch-site': 'cross-site' })).toBe(false);
  });

  test('without Sec-Fetch-Site, Origin must match Host; no Origin passes', () => {
    expect(refused('POST', { cookie: COOKIE, origin: 'https://evil.p.example', host: 'api.example' })).toBe(true);
    expect(refused('POST', { cookie: COOKIE, origin: 'https://api.example', host: 'api.example' })).toBe(false);
    expect(refused('POST', { cookie: COOKIE, origin: 'not a url', host: 'api.example' })).toBe(true);
    expect(refused('POST', { cookie: COOKIE })).toBe(false);
  });

  test('an explicit credential header or no cookie is not ambient', () => {
    expect(refused('POST', { cookie: COOKIE, authorization: 'Bearer x', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(refused('POST', { cookie: COOKIE, 'x-kortix-token': 'kortix_x', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(refused('POST', { 'sec-fetch-site': 'cross-site' })).toBe(false);
  });
});
