import { describe, expect, test } from 'bun:test';

import type { CaptureStorageView } from '@kortix/sdk';

import { toDraft, toInput, validStorageDraft, type StorageDraft } from './storage-model';

const S3_VIEW: CaptureStorageView = {
  mode: 's3',
  endpoint: 'https://s3.example.com',
  region: 'eu-west-1',
  bucket: 'my-recordings',
  force_path_style: true,
  role_arn: '',
  access_key_id: 'AKIAEXAMPLE',
  has_secret: true,
  per_device_scoped: false,
};

describe('toDraft', () => {
  test('managed view opens the kortix draft', () => {
    expect(toDraft({ mode: 'kortix' }).mode).toBe('kortix');
  });

  test('an s3 view opens its fields; a stored static key is keys mode; the secret is never read back', () => {
    const d = toDraft(S3_VIEW);
    expect(d).toMatchObject({ mode: 's3', bucket: 'my-recordings', region: 'eu-west-1', forcePathStyle: true, credKind: 'keys', accessKeyId: 'AKIAEXAMPLE' });
    expect(d.secretAccessKey).toBe('');
  });

  test('a role_arn view opens in role mode', () => {
    expect(toDraft({ ...S3_VIEW, role_arn: 'arn:aws:iam::1:role/x', access_key_id: '' }).credKind).toBe('role');
  });
});

describe('toInput', () => {
  const base: StorageDraft = {
    mode: 's3', endpoint: ' https://s3.example.com ', region: ' eu-west-1 ', bucket: ' my-recordings ',
    forcePathStyle: true, credKind: 'keys', roleArn: '', accessKeyId: ' AKIAEXAMPLE ', secretAccessKey: 'shh',
  };

  test('kortix draft sends only the mode', () => {
    expect(toInput({ ...base, mode: 'kortix' })).toEqual({ mode: 'kortix' });
  });

  test('keys mode trims and sends only the key pair, never a role_arn', () => {
    const input = toInput(base);
    expect(input).toEqual({ mode: 's3', endpoint: 'https://s3.example.com', region: 'eu-west-1', bucket: 'my-recordings', force_path_style: true, access_key_id: 'AKIAEXAMPLE', secret_access_key: 'shh' });
    expect('role_arn' in input).toBe(false);
  });

  test('role mode sends only the role_arn, never a key pair (the API either/or rule)', () => {
    const input = toInput({ ...base, credKind: 'role', roleArn: ' arn:aws:iam::1:role/x ' });
    expect(input).toEqual({ mode: 's3', endpoint: 'https://s3.example.com', region: 'eu-west-1', bucket: 'my-recordings', force_path_style: true, role_arn: 'arn:aws:iam::1:role/x' });
    expect('access_key_id' in input).toBe(false);
    expect('secret_access_key' in input).toBe(false);
  });
});

describe('validStorageDraft', () => {
  const s3: StorageDraft = {
    mode: 's3', endpoint: '', region: 'us-east-1', bucket: 'b', forcePathStyle: false,
    credKind: 'role', roleArn: 'arn:aws:iam::1:role/x', accessKeyId: '', secretAccessKey: '',
  };

  test('kortix is always valid', () => {
    expect(validStorageDraft({ ...s3, mode: 'kortix' })).toBe(true);
  });

  test('s3 needs region and bucket', () => {
    expect(validStorageDraft({ ...s3, bucket: '' })).toBe(false);
    expect(validStorageDraft({ ...s3, region: '' })).toBe(false);
  });

  test('role mode needs a role_arn', () => {
    expect(validStorageDraft(s3)).toBe(true);
    expect(validStorageDraft({ ...s3, roleArn: '' })).toBe(false);
  });

  test('keys mode needs both the id and the secret', () => {
    const keys: StorageDraft = { ...s3, credKind: 'keys', roleArn: '' };
    expect(validStorageDraft({ ...keys, accessKeyId: 'AKIA', secretAccessKey: 's' })).toBe(true);
    expect(validStorageDraft({ ...keys, accessKeyId: 'AKIA', secretAccessKey: '' })).toBe(false);
    expect(validStorageDraft({ ...keys, accessKeyId: '', secretAccessKey: 's' })).toBe(false);
  });
});
