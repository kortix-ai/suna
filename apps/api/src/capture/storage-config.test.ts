/**
 * Unit: the per-account storage secret envelope and the input/stored/view
 * mapping. Hermetic — no DB, no network. The crypto is the money path: a leaked
 * or mis-decrypted BYO key is an incident.
 */
import { describe, expect, test } from 'bun:test';
import {
  decryptStorageSecret,
  encryptStorageSecret,
  resolveInput,
  S3InputSchema,
  StorageInputSchema,
  toStored,
} from './storage-config';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('storage secret envelope', () => {
  test('round-trips a secret and binds it to the account', () => {
    const enc = encryptStorageSecret(ACCOUNT, 'top-secret-key');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('top-secret-key');
    expect(decryptStorageSecret(ACCOUNT, enc)).toBe('top-secret-key');
    // A different account's key cannot decrypt it (auth tag fails).
    expect(() => decryptStorageSecret(OTHER, enc)).toThrow();
  });

  test('two encryptions of the same value differ (random IV)', () => {
    expect(encryptStorageSecret(ACCOUNT, 'x')).not.toBe(encryptStorageSecret(ACCOUNT, 'x'));
  });
});

describe('toStored', () => {
  test('encrypts the static secret and keeps the id in clear', () => {
    const input = S3InputSchema.parse({ mode: 's3', region: 'us-east-1', bucket: 'b', access_key_id: 'AKIA', secret_access_key: 'shh' });
    const stored = toStored(ACCOUNT, input) as Record<string, string>;
    expect(stored.access_key_id).toBe('AKIA');
    expect(stored.secret_access_key_enc).not.toContain('shh');
    expect(decryptStorageSecret(ACCOUNT, stored.secret_access_key_enc)).toBe('shh');
    expect('secret_access_key' in stored).toBe(false);
  });

  test('kortix mode stores only the mode', () => {
    expect(toStored(ACCOUNT, { mode: 'kortix' })).toEqual({ mode: 'kortix' });
  });
});

describe('StorageInputSchema', () => {
  test('requires exactly one credential form for s3', () => {
    expect(StorageInputSchema.safeParse({ mode: 's3', region: 'r', bucket: 'b' }).success).toBe(false);
    expect(StorageInputSchema.safeParse({ mode: 's3', region: 'r', bucket: 'b', role_arn: 'arn:aws:iam::1:role/x' }).success).toBe(true);
    expect(
      StorageInputSchema.safeParse({ mode: 's3', region: 'r', bucket: 'b', access_key_id: 'AKIA', secret_access_key: 's' }).success,
    ).toBe(true);
    // Both forms at once is rejected.
    expect(
      StorageInputSchema.safeParse({ mode: 's3', region: 'r', bucket: 'b', role_arn: 'arn', access_key_id: 'AKIA', secret_access_key: 's' }).success,
    ).toBe(false);
    // access_key_id without a secret is rejected.
    expect(StorageInputSchema.safeParse({ mode: 's3', region: 'r', bucket: 'b', access_key_id: 'AKIA' }).success).toBe(false);
  });
});

describe('resolveInput', () => {
  test('maps the plaintext input to the server-side resolved shape', () => {
    const r = resolveInput({ mode: 's3', endpoint: '', region: '', bucket: 'b', force_path_style: true, role_arn: '', access_key_id: 'AKIA', secret_access_key: 'shh' });
    expect(r).toEqual({ mode: 's3', endpoint: '', region: 'us-east-1', bucket: 'b', forcePathStyle: true, roleArn: '', accessKeyId: 'AKIA', secretAccessKey: 'shh' });
  });
});
