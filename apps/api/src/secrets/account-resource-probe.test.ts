/**
 * The account-secret envelope family (provider keys, ChatGPT logins): the
 * decrypt probe the account secrets list reports per row (KRTX-1719).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { encryptAccountSecret, probeAccountSecret, readAccountSecret } from './account-resource';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const originalKey = config.API_KEY_SECRET;

afterEach(() => {
  config.API_KEY_SECRET = originalKey;
});

describe('probeAccountSecret', () => {
  test('a value written under the current key is ok', () => {
    expect(probeAccountSecret(ACCOUNT_ID, encryptAccountSecret(ACCOUNT_ID, 'synthetic-key'))).toBe('ok');
  });

  test('a changed API_KEY_SECRET makes an earlier value undecryptable, and the read returns null', () => {
    const envelope = encryptAccountSecret(ACCOUNT_ID, 'synthetic-key');
    config.API_KEY_SECRET = `${originalKey}-rotated`;
    expect(probeAccountSecret(ACCOUNT_ID, envelope)).toBe('undecryptable');
    expect(readAccountSecret(ACCOUNT_ID, 'secret-1', envelope)).toBeNull();
  });

  test('a damaged, malformed or foreign-account envelope is undecryptable', () => {
    const envelope = encryptAccountSecret(ACCOUNT_ID, 'synthetic-key');
    const [version, iv, tag, ciphertext] = envelope.split(':');
    const flipped = `${ciphertext![0] === 'A' ? 'B' : 'A'}${ciphertext!.slice(1)}`;
    expect(probeAccountSecret(ACCOUNT_ID, [version, iv, tag, flipped].join(':'))).toBe('undecryptable');
    expect(probeAccountSecret(ACCOUNT_ID, 'not-an-envelope')).toBe('undecryptable');
    expect(probeAccountSecret(OTHER_ACCOUNT_ID, envelope)).toBe('undecryptable');
  });
});
