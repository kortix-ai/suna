import { createHash } from 'crypto';
import { hashSecretKey } from '../shared/crypto';

// OAuth access/refresh tokens (kortix_oat_ / kortix_ort_) are stored under the
// same peppered-scrypt scheme as the rest of the credential system
// (crypto.hashSecretKey), rather than the bare unpeppered sha256 they used to
// use. Both schemes are deterministic — scrypt here is peppered with
// API_KEY_SECRET, not per-token salted — so hash-equality lookup still works;
// we just look up over BOTH candidate hashes so tokens minted before this
// change keep validating until they expire (access 1h, refresh 30d). The
// legacy branch can be deleted after that window.

/** How new oauth tokens are hashed for storage. */
export function hashOauthToken(token: string): string {
  return hashSecretKey(token);
}

/** The pre-change scheme (bare sha256), kept only for dual-read validation. */
export function legacyHashOauthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Both hashes a presented token could be stored under, newest first. Use in
 *  an `inArray(tokenHash, …)` lookup so old and new tokens both validate. */
export function oauthTokenHashCandidates(token: string): string[] {
  return [hashOauthToken(token), legacyHashOauthToken(token)];
}
