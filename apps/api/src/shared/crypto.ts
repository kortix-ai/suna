import { createHash, createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { config } from '../config';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomAlphanumeric(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[bytes[i]! % CHARS.length];
  }
  return result;
}

/**
 * Kortix API key prefixes.
 *
 *   kortix_      — user-created API key (for external programmatic access)
 *   kortix_sb_   — sandbox-managed key (auto-created per sandbox, used by agents)
 *   pk_          — public key identifier (safe to store/display)
 *
 * Both secret key variants validate through the same path — only the hash is stored.
 */
export const KEY_PREFIX = 'kortix_';
export const KEY_PREFIX_SANDBOX = 'kortix_sb_';
export const KEY_PREFIX_TUNNEL = 'kortix_tnl_';
export const KEY_PREFIX_PAT = 'kortix_pat_';
export const KEY_PREFIX_SA = 'kortix_sa_';
export const KEY_PREFIX_PUBLIC = 'pk_';

const SECRET_RANDOM_LENGTH = 32;

/**
 * Check if a token is a Kortix-issued key (user or sandbox).
 * Single check for the router — no branching on multiple prefixes.
 */
export function isKortixToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

/**
 * Generate a public/secret key pair for a user-created API key.
 * Secret key: kortix_<32 chars>  (shown once, only hash stored)
 * Public key:  pk_<32 chars>     (safe to store/display)
 */
export function generateApiKeyPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/**
 * Generate a public/secret key pair for a sandbox-managed key.
 * Secret key: kortix_sb_<32 chars>  (injected as KORTIX_TOKEN into sandbox)
 * Public key: pk_<32 chars>          (safe to store/display)
 */
export function generateSandboxKeyPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX_SANDBOX}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/**
 * Generate a tunnel-specific setup token.
 * Token: kortix_tnl_<32 chars> (shown once during tunnel creation, only hash stored)
 */
export function generateTunnelToken(): string {
  return `${KEY_PREFIX_TUNNEL}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`;
}

/**
 * Generate a Personal Access Token (PAT) for the CLI.
 * Secret key: kortix_pat_<32 chars>  (shown once, only hash stored)
 * Public key: pk_<32 chars>           (safe to store/display)
 */
export function generateAccountTokenPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX_PAT}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/** Check if a token is a CLI Personal Access Token. */
export function isAccountToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_PAT);
}

/**
 * Generate a service-account bearer.
 * Secret: kortix_sa_<32 chars>  (shown once, only hash stored)
 * Public prefix is the first 16 chars after the prefix — used purely as
 * a display identifier in admin lists.
 */
export function generateServiceAccountSecret(): { secret: string; publicPrefix: string } {
  const body = randomAlphanumeric(SECRET_RANDOM_LENGTH);
  return {
    secret: `${KEY_PREFIX_SA}${body}`,
    publicPrefix: `${KEY_PREFIX_SA}${body.slice(0, 8)}…`,
  };
}

/** Check if a token is a service-account bearer. */
export function isServiceAccountToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_SA);
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/**
 * Generate a human-readable device auth code: XXXX-NNNN
 * (4 uppercase letters + hyphen + 4 digits)
 */
export function generateDeviceCode(): string {
  const bytes = randomBytes(8);
  let letters = '';
  let numbers = '';
  for (let i = 0; i < 4; i++) {
    letters += UPPER[bytes[i]! % UPPER.length];
    numbers += DIGITS[bytes[i + 4]! % DIGITS.length];
  }
  return `${letters}-${numbers}`;
}

/** Check if a token is a tunnel setup token. */
export function isTunnelToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_TUNNEL);
}

export function hashSecretKey(secretKey: string): string {
  const secret = config.API_KEY_SECRET;
  if (!secret) {
    throw new Error('API_KEY_SECRET not configured');
  }

  return createHmac('sha256', secret)
    .update(secretKey)
    .digest('hex');
}

export function verifySecretKey(secretKey: string, storedHash: string): boolean {
  try {
    const computedHash = hashSecretKey(secretKey);

    const storedBuffer = Buffer.from(storedHash, 'hex');
    const computedBuffer = Buffer.from(computedHash, 'hex');

    if (storedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

export function isApiKeySecretConfigured(): boolean {
  return !!config.API_KEY_SECRET;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Hashes both inputs with SHA-256 first so the comparison is always
 * on fixed-length 32-byte digests — no string length leakage.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function deriveSigningKey(token: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(token)
    .digest('hex');
}

export function signMessage(signingKey: string, payload: string, nonce: number): string {
  return createHmac('sha256', signingKey)
    .update(`${nonce}:${payload}`)
    .digest('hex');
}

export function verifyMessageSignature(
  signingKey: string,
  payload: string,
  nonce: number,
  signature: string,
): boolean {
  try {
    const expected = signMessage(signingKey, payload, nonce);
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
