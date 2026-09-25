import { createHash } from 'crypto';
import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-pepper' } }));

const { hashOauthToken, hashPresentedOauthToken } = await import('./token-hash');

describe('oauth token hashing', () => {
  // Obviously-fake literal; the trailing marker exempts it from secret scanning.
  const token = 'kortix_oat_FAKE_TEST_TOKEN'; // gitleaks:allow

  test('tokens hash under the peppered-scrypt scheme, not bare sha256', () => {
    const hash = hashOauthToken(token);
    expect(hash.startsWith('scrypt:v1:')).toBe(true);
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
  });

  test('hashing is deterministic so hash-equality lookup works', () => {
    expect(hashOauthToken(token)).toBe(hashOauthToken(token));
  });

  test('a presented token hashes to the value stored at mint', async () => {
    expect(await hashPresentedOauthToken(token)).toBe(hashOauthToken(token));
    const refresh = 'kortix_ort_FAKE_TEST_TOKEN'; // gitleaks:allow
    expect(await hashPresentedOauthToken(refresh)).toBe(hashOauthToken(refresh));
  });

  test('distinct tokens produce distinct hashes', () => {
    expect(hashOauthToken('kortix_oat_one')).not.toBe(hashOauthToken('kortix_oat_two'));
  });
});
