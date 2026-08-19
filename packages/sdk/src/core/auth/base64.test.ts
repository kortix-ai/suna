import { describe, expect, test } from 'bun:test';

import { base64UrlDecode, base64UrlEncode } from './base64';

describe('base64UrlEncode', () => {
  test('matches Node\'s base64url for every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  test('emits no padding and no + or /', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 62, 63, 64]) {
      const bytes = new Uint8Array(length).fill(251);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe('base64UrlDecode', () => {
  test('decodes base64url with - and _ and no padding', () => {
    const source = JSON.stringify({ sub: 'a?~>>>???', exp: 1 });
    const encoded = Buffer.from(source, 'utf8').toString('base64url');
    expect(encoded).toMatch(/[-_]/);
    expect(base64UrlDecode(encoded)).toBe(source);
  });

  test('decodes standard base64 with padding too', () => {
    const encoded = Buffer.from('hello world', 'utf8').toString('base64');
    expect(base64UrlDecode(encoded)).toBe('hello world');
  });

  test('throws on a non-base64 character rather than returning garbage', () => {
    // A silent garbage decode would produce a JSON parse failure two layers up
    // and read as "this token never expires".
    expect(() => base64UrlDecode('@@@not-base64@@@')).toThrow();
  });
});
