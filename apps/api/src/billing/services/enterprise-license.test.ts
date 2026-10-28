import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parseLicenseKey } from './enterprise-license';

const kortix = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function keyFor(body: unknown, privateKey = kortix.privateKey): string {
  const payload = Buffer.from(JSON.stringify(body));
  return `${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`;
}

const valid = { licensee: 'Example Org', expires_at: '2027-10-31T00:00:00.000Z' };

describe('parseLicenseKey', () => {
  test('a key signed by Kortix returns its licensee and end date', () => {
    expect(parseLicenseKey(keyFor(valid), kortix.publicKey)).toEqual({
      licensee: 'Example Org',
      expiresAt: new Date('2027-10-31T00:00:00.000Z'),
    });
  });

  test('a key signed by any other key is refused', () => {
    expect(parseLicenseKey(keyFor(valid, other.privateKey), kortix.publicKey)).toBeNull();
  });

  test('the production public key refuses a key from a test keypair', () => {
    expect(parseLicenseKey(keyFor(valid))).toBeNull();
  });

  test('a changed payload is refused', () => {
    const [, signature] = keyFor(valid).split('.');
    const forged = Buffer.from(JSON.stringify({ ...valid, expires_at: '2099-01-01' })).toString('base64url');
    expect(parseLicenseKey(`${forged}.${signature}`, kortix.publicKey)).toBeNull();
  });

  test('missing, malformed and incomplete keys are refused', () => {
    for (const key of [undefined, '', 'abc', 'a.b.c', 'true', '.sig']) {
      expect(parseLicenseKey(key, kortix.publicKey)).toBeNull();
    }
    expect(parseLicenseKey(keyFor({ expires_at: valid.expires_at }), kortix.publicKey)).toBeNull();
    expect(parseLicenseKey(keyFor({ licensee: 'Example Org', expires_at: 'soon' }), kortix.publicKey)).toBeNull();
  });
});
