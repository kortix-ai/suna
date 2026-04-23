import { describe, expect, it } from 'bun:test';

import { getRequestUrl } from '../lib/request-url';

describe('getRequestUrl', () => {
  it('returns absolute Bun request URLs unchanged', () => {
    const req = new Request('http://localhost:8008/v1/health?check=1');
    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('http://localhost:8008/v1/health?check=1');
  });

  it('normalizes relative Bun request URLs using host header', () => {
    const req = new Request('http://placeholder.invalid', {
      headers: { host: 'api.kortix.com' },
    });
    Object.defineProperty(req, 'url', { value: '/', configurable: true });

    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('http://api.kortix.com/');
  });

  it('prefers forwarded proto and host when present', () => {
    const req = new Request('http://placeholder.invalid', {
      headers: {
        host: 'internal:8008',
        'x-forwarded-host': 'kortix.com',
        'x-forwarded-proto': 'https',
      },
    });
    Object.defineProperty(req, 'url', { value: '/status?full=1', configurable: true });

    const url = getRequestUrl(req, 8008);

    expect(url.toString()).toBe('https://kortix.com/status?full=1');
  });
});
