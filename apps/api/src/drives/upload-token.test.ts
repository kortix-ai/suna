import { expect, mock, test } from 'bun:test';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-secret-value-32-chars-long!!' } }));
const { openDriveUpload, sealDriveUpload } = await import('./upload-token');

const upload = { uploadId: 'up_1', driveId: 'drive-a', userId: 'user-a', path: '/Users/a/big.bin', size: 5 };
const who = { driveId: 'drive-a', userId: 'user-a' };

test('a sealed upload opens for its own drive and person, until it expires', () => {
  const token = sealDriveUpload({ ...upload, ifMatch: '"v1"' }, 1_000);
  expect(openDriveUpload(token, who, 2_000)).toEqual({ ...upload, ifMatch: '"v1"' });
  expect(openDriveUpload(token, who, 1_000 + 24 * 60 * 60_000)).toBeNull();
});

test('another drive, another person, or a changed token is refused', () => {
  const token = sealDriveUpload(upload);
  expect(openDriveUpload(token, { ...who, driveId: 'drive-b' })).toBeNull();
  expect(openDriveUpload(token, { ...who, userId: 'user-b' })).toBeNull();
  const [body, sig] = token.split('.') as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...upload, path: '/Users/b/x', exp: Date.now() + 1e6 })).toString('base64url');
  expect(openDriveUpload(`${forged}.${sig}`, who)).toBeNull();
  expect(openDriveUpload(`${body}.${sig}x`, who)).toBeNull();
  expect(openDriveUpload(`${token}.x`, who)).toBeNull();
  expect(openDriveUpload('up_1', who)).toBeNull();
});
