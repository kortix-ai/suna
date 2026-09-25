import { hashSecretKey } from '../shared/crypto';
import { hashSecretKeyAsync } from '../shared/token-hash';

// OAuth access/refresh tokens (kortix_oat_ / kortix_ort_) are stored under the
// peppered-scrypt scheme of the rest of the credential system
// (crypto.hashSecretKey). The scheme is deterministic — peppered with
// API_KEY_SECRET, not per-token salted — so a presented token is found by
// hash equality on the unique `token_hash` column.

/** The stored hash of a newly minted token. */
export function hashOauthToken(token: string): string {
  return hashSecretKey(token);
}

/** The lookup hash of a PRESENTED token: the scrypt runs off the event loop
 *  and is remembered (shared/token-hash.ts). Use on every validation path. */
export function hashPresentedOauthToken(token: string): Promise<string> {
  return hashSecretKeyAsync(token);
}
