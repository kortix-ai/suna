import { createHash } from 'crypto';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-pepper' } }));

const { hashOauthToken, legacyHashOauthToken, oauthTokenHashCandidates } = await import(
  './token-hash'
);

describe('oauth token hashing', () => {
  // Obviously-fake literal; the trailing marker exempts it from secret scanning.
  const token = 'kortix_oat_FAKE_TEST_TOKEN'; // gitleaks:allow

  test('new tokens hash under the peppered-scrypt scheme, not bare sha256', () => {
    const hash = hashOauthToken(token);
    expect(hash.startsWith('scrypt:v1:')).toBe(true);
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
  });

  test('hashing is deterministic so hash-equality lookup still works', () => {
    expect(hashOauthToken(token)).toBe(hashOauthToken(token));
  });

  test('legacy hash matches the pre-change bare sha256', () => {
    expect(legacyHashOauthToken(token)).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
  });

  test('candidates cover both schemes, scrypt first — a token stored either way validates', () => {
    const candidates = oauthTokenHashCandidates(token);
    expect(candidates).toEqual([hashOauthToken(token), legacyHashOauthToken(token)]);
    // A token minted before this change (legacy hash on the row) is still found.
    expect(candidates).toContain(createHash('sha256').update(token).digest('hex'));
    // A token minted after (scrypt hash on the row) is found too.
    expect(candidates).toContain(hashOauthToken(token));
  });

  test('distinct tokens produce distinct hashes', () => {
    expect(hashOauthToken('kortix_oat_one')).not.toBe(hashOauthToken('kortix_oat_two'));
  });
});
