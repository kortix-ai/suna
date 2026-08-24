import { describe, expect, it } from 'bun:test';
import { resolvePrefixEscape } from './prefix-escape';

const ORIGIN = 'https://dev-api.kortix.com';
const PREVIEW = `${ORIGIN}/v1/p/sbx_01M0G4HXCM32BX5R1GPYZDYC1H/8081/`;

function navigation(path: string, extra: Record<string, string> = {}, method = 'GET') {
  return {
    method,
    url: `${ORIGIN}${path}`,
    headers: new Headers({
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      referer: PREVIEW,
      ...extra,
    }),
  };
}

describe('resolvePrefixEscape', () => {
  it('sends a root-absolute link click back into the preview prefix', () => {
    expect(resolvePrefixEscape(navigation('/learn'))).toEqual({
      location: '/v1/p/sbx_01M0G4HXCM32BX5R1GPYZDYC1H/8081/learn',
      status: 302,
    });
  });

  it('preserves the query string', () => {
    expect(resolvePrefixEscape(navigation('/learn?tab=2&q=a%20b'))?.location).toBe(
      '/v1/p/sbx_01M0G4HXCM32BX5R1GPYZDYC1H/8081/learn?tab=2&q=a%20b',
    );
  });

  it('keeps the method on a form POST by answering 307', () => {
    expect(resolvePrefixEscape(navigation('/submit', {}, 'POST'))).toEqual({
      location: '/v1/p/sbx_01M0G4HXCM32BX5R1GPYZDYC1H/8081/submit',
      status: 307,
    });
  });

  it('reads the prefix from a deep preview page, not just its root', () => {
    const req = navigation('/learn', {
      referer: `${ORIGIN}/v1/p/sbx_abc/3000/docs/intro?x=1`,
    });
    expect(resolvePrefixEscape(req)?.location).toBe('/v1/p/sbx_abc/3000/learn');
  });

  it('ignores XHR/fetch — only navigations carry a recoverable intent', () => {
    const req = navigation('/api/items', { 'sec-fetch-dest': 'empty' });
    expect(resolvePrefixEscape(req)).toBeNull();
  });

  it('ignores sub-resource loads (scripts, styles, images)', () => {
    for (const dest of ['script', 'style', 'image', 'font', 'iframe']) {
      expect(resolvePrefixEscape(navigation('/app.js', { 'sec-fetch-dest': dest }))).toBeNull();
    }
  });

  it('ignores a cross-origin referer (never an open redirect)', () => {
    const req = navigation('/learn', {
      referer: 'https://evil.example.com/v1/p/sbx_x/8081/',
    });
    expect(resolvePrefixEscape(req)).toBeNull();
  });

  it('ignores a same-origin referer that is not a preview page', () => {
    expect(resolvePrefixEscape(navigation('/learn', { referer: `${ORIGIN}/v1/health` }))).toBeNull();
  });

  it('ignores a request with no referer', () => {
    const headers = new Headers({ 'sec-fetch-dest': 'document' });
    expect(resolvePrefixEscape({ method: 'GET', url: `${ORIGIN}/learn`, headers })).toBeNull();
  });

  it('never rewrites a path already inside the proxy (no redirect loops)', () => {
    const req = navigation('/v1/p/sbx_other/8081/missing');
    expect(resolvePrefixEscape(req)).toBeNull();
  });

  it('accepts a legacy client with Accept: text/html and no Sec-Fetch headers', () => {
    const headers = new Headers({ accept: 'text/html,*/*', referer: PREVIEW });
    expect(resolvePrefixEscape({ method: 'GET', url: `${ORIGIN}/learn`, headers })?.status).toBe(302);
  });

  it('rejects a JSON API call that merely carries a preview referer', () => {
    const headers = new Headers({ accept: 'application/json', referer: PREVIEW });
    expect(resolvePrefixEscape({ method: 'GET', url: `${ORIGIN}/v1/threads`, headers })).toBeNull();
  });

  it('rejects a malformed referer', () => {
    expect(resolvePrefixEscape(navigation('/learn', { referer: 'not a url' }))).toBeNull();
  });

  it('rejects a referer whose port segment is not numeric', () => {
    const req = navigation('/learn', { referer: `${ORIGIN}/v1/p/sbx_abc/auth/` });
    expect(resolvePrefixEscape(req)).toBeNull();
  });
});
