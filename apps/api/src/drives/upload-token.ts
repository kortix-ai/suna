// The id a person's block upload goes by (drives/routes.ts): storage's upload
// id, sealed with the drive, the person, the path, the size and the version
// the upload replaces. Signed, not stored, so any API process verifies it, and
// one person's upload id is refused on another drive, path or person. Storage
// keeps its own lease on the upload; this only bounds how long the id is honored.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export interface DriveUpload {
  /** Storage's upload id. */
  uploadId: string;
  driveId: string;
  userId: string;
  path: string;
  size: number;
  /** The file version the upload replaces (`If-Match` at plan time). */
  ifMatch?: string;
}

const UPLOAD_TOKEN_TTL_MS = 24 * 60 * 60_000;

/** Domain-separated from every other use of API_KEY_SECRET. */
const key = () => createHmac('sha256', config.API_KEY_SECRET).update('drive-upload:v1').digest();
const mac = (body: string) => createHmac('sha256', key()).update(body).digest('base64url');

export function sealDriveUpload(upload: DriveUpload, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...upload, exp: now + UPLOAD_TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The upload the token names, when it is genuine, unexpired, and for this drive and person; otherwise null. */
export function openDriveUpload(token: string, expect: { driveId: string; userId: string }, now = Date.now()): DriveUpload | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let parsed: DriveUpload & { exp: number };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!(parsed.exp > now) || parsed.driveId !== expect.driveId || parsed.userId !== expect.userId) return null;
  const { exp: _exp, ...upload } = parsed;
  return upload;
}
