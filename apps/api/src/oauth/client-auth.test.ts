import { describe, expect, test } from 'bun:test';
import { basicClientAuth } from './index';

/**
 * RFC 6749 §2.3.1 client authentication via HTTP Basic. Before this, /token
 * read `client_id`/`client_secret` from the body only, so a confidential
 * client registered with `token_endpoint_auth_method: client_secret_basic`
 * (the default many OAuth libraries use) could never authenticate.
 */
describe('basicClientAuth', () => {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

  test('decodes a plain client_id:client_secret pair', () => {
    expect(basicClientAuth(`Basic ${encode('abc-123:s3cret')}`)).toEqual({
      clientId: 'abc-123',
      clientSecret: 's3cret',
    });
  });

  test('decodes the form-urlencoded halves RFC 6749 specifies', () => {
    expect(basicClientAuth(`Basic ${encode('a%20b:s%3Acret')}`)).toEqual({
      clientId: 'a b',
      clientSecret: 's:cret',
    });
  });

  test('is case-insensitive on the scheme and tolerates surrounding space', () => {
    expect(basicClientAuth(`  bAsIc   ${encode('c:s')}  `)).toEqual({
      clientId: 'c',
      clientSecret: 's',
    });
  });

  test('a secret that contains a colon is kept whole', () => {
    expect(basicClientAuth(`Basic ${encode('id:se:cret')}`)).toEqual({
      clientId: 'id',
      clientSecret: 'se:cret',
    });
  });

  test('returns null for anything that is not Basic credentials', () => {
    expect(basicClientAuth(undefined)).toBeNull();
    expect(basicClientAuth('')).toBeNull();
    expect(basicClientAuth('Bearer abc')).toBeNull();
    expect(basicClientAuth(`Basic ${encode('no-colon')}`)).toBeNull();
  });
});
